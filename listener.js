const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const logger = require('./logger');

// Inicialización de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración producción
const TRON_TREASURY_ADDRESS = process.env.TRON_TREASURY_ADDRESS;
const BSC_TREASURY_ADDRESS = process.env.BSC_TREASURY_ADDRESS;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;

// Contratos mainnet
const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT Mainnet
const BSC_USDT_CONTRACT = '0x55d398326f99059ff775485246999027b3197955'; // USDT BSC Mainnet

// Validadores
const isValidTronAddress = (address) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
const isValidBscAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);

if (!isValidTronAddress(TRON_TREASURY_ADDRESS)) throw new Error('Dirección TRON inválida en .env');
if (!isValidBscAddress(BSC_TREASURY_ADDRESS)) throw new Error('Dirección BSC inválida en .env');

logger.info('Listener producción - Mainnet iniciado', {
    tron_address: TRON_TREASURY_ADDRESS,
    bsc_address: BSC_TREASURY_ADDRESS
});

// Configuración flexible para testing
const CONFIG = {
    TESTING_MODE: process.env.TESTING_MODE === "true",
    BASE_AMOUNT: process.env.TESTING_MODE === "true" ? 1 : 15,
    TOLERANCE: 0.01,
    POLL_INTERVAL: process.env.TESTING_MODE === "true" ? 5000 : 10000,
    API_TIMEOUT: 15000,
    MAX_API_RETRIES: 3,
    DEFAULT_EXPIRATION_MINUTES: 15,
    TIMESTAMP_MARGIN: 3600000 // 1 hora en ms
};

logger.info(`Configuración del listener`, {
    mode: CONFIG.TESTING_MODE ? 'TESTING' : 'PRODUCCIÓN',
    base_amount: `${CONFIG.BASE_AMOUNT} USDT (con ajuste aleatorio)`,
    tolerance: `${CONFIG.TOLERANCE} USDT`,
    poll_interval: `${CONFIG.POLL_INTERVAL/1000}s`
});

/**
 * TRON MAINNET
 */
async function checkTronPayments() {
    logger.info(`[TRON] Verificando pagos ${CONFIG.TESTING_MODE ? `(Testing: ~${CONFIG.BASE_AMOUNT}.00xxx USDT)` : '(Producción)'}`);
    
    let pollingFailed = true; // Flag para fallback

    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at, id')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders?.length) {
            logger.info('[TRON] Sin órdenes pendientes');
            pollingFailed = false;
            return;
        }

        const validOrders = pendingOrders;
        if (validOrders.length === 0) {
            logger.warn('[TRON] No hay órdenes pendientes válidas');
            pollingFailed = false;
            return;
        }

        // Solo TronGrid (con tu API key existente)
        const api = {
            name: 'TronGrid Mainnet',
            url: `https://api.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions/trc20?limit=50&only_to=true`,
            parser: parseTronGridResponse
        };

        let retries = 0;
        while (retries < CONFIG.MAX_API_RETRIES) {
            try {
                logger.info(`[TRON] Consultando ${api.name} (Intento ${retries + 1})`);
                
                const response = await fetch(api.url, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'PaymentListener/1.0',
                        ...(TRONGRID_API_KEY && { 'TRON-PRO-API-KEY': TRONGRID_API_KEY })
                    },
                    timeout: CONFIG.API_TIMEOUT
                });

                if (!response.ok) {
                    logger.warn(`[TRON] Error en ${api.name}`, { status: response.status });
                    retries++;
                    continue;
                }

                const data = await response.json();
                const transactions = api.parser(data);
                
                if (transactions.length > 0) {
                    logger.info(`[TRON] ${api.name}: ${transactions.length} transacciones encontradas`);
                    
                    for (const tx of transactions) {
                        const { data: existingTx, error: txError } = await supabase
                            .from('payment_orders')
                            .select('id')
                            .eq('transaction_hash', tx.hash)
                            .single();

                        if (txError && txError.code !== 'PGRST116') {
                            logger.error('[TRON] Error verificando hash existente', { hash: tx.hash, error: txError.message });
                            continue;
                        }

                        if (existingTx) {
                            logger.warn('[TRON] Hash ya procesado, omitiendo', { hash: tx.hash });
                            continue;
                        }
                        
                        logger.info(`[TRON] Verificando transacción: ${tx.amount} USDT`, { hash: tx.hash });
                        
                        const matchingOrder = validOrders.find(order => 
                            Math.abs(order.amount - tx.amount) < CONFIG.TOLERANCE
                        );

                        if (!matchingOrder) {
                            logger.warn('[TRON] No se encontró orden coincidente para monto', { amount: tx.amount });
                            continue;
                        }

                        const orderCreatedAt = new Date(matchingOrder.created_at).getTime();
                        const txTimestamp = tx.timestamp;
                        if (txTimestamp < (orderCreatedAt - CONFIG.TIMESTAMP_MARGIN)) {
                            logger.warn('[TRON] Transacción antigua, omitiendo', { hash: tx.hash, tx_timestamp: txTimestamp, order_created: orderCreatedAt });
                            continue;
                        }

                        logger.info(`[TRON] Pago detectado para orden ${matchingOrder.id}`, {
                            amount: tx.amount,
                            user_id: matchingOrder.user_id,
                            hash: tx.hash
                        });
                        
                        await activateUser(matchingOrder.user_id, tx.hash, 'TRON', tx.amount);
                        await sendPaymentNotification(matchingOrder, { hash: tx.hash, amount: tx.amount }, 'TRON');
                    }
                } else {
                    logger.info('[TRON] No hay transacciones recientes');
                }

                pollingFailed = false;
                break; // Éxito: salir de los reintentos

            } catch (error) {
                logger.warn(`[TRON] Error en ${api.name} (Intento ${retries + 1})`, { error: error.message });
                retries++;
                if (retries < CONFIG.MAX_API_RETRIES) {
                    // Backoff exponencial para reintentos
                    await new Promise(resolve => setTimeout(resolve, 2000 * retries));
                }
            }
        }

    } catch (error) {
        logger.error('[TRON] Error en verificación de pagos', { error: error.message });
    }

    if (pollingFailed) {
        logger.warn('[TRON] Polling falló, cayendo a webhook backup');
    }
}

/**
 * BSC MAINNET
 */
async function checkBscPayments() {
    logger.info(`[BSC] Verificando pagos ${CONFIG.TESTING_MODE ? `(Testing: ~${CONFIG.BASE_AMOUNT}.00xxx USDT)` : '(Producción)'}`);
    
    let pollingFailed = true;

    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at, id')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders?.length) {
            logger.info('[BSC] Sin órdenes pendientes');
            pollingFailed = false;
            return;
        }

        const validOrders = pendingOrders;
        if (validOrders.length === 0) {
            logger.warn('[BSC] No hay órdenes pendientes válidas');
            pollingFailed = false;
            return;
        }

        // APIs para BSC (Etherscan y BSCScan)
        const apis = [
            {
                name: 'BSCScan Mainnet',
                url: `https://api.bscscan.com/api?module=account&action=tokentx&address=${BSC_TREASURY_ADDRESS}&contractaddress=${BSC_USDT_CONTRACT}&sort=desc&apikey=${ETHERSCAN_API_KEY}`,
                parser: parseBscScanResponse
            },
            {
                name: 'Etherscan Proxy (BSC)',
                url: `https://api.etherscan.io/api?module=account&action=tokentx&address=${BSC_TREASURY_ADDRESS}&contractaddress=${BSC_USDT_CONTRACT}&sort=desc&apikey=${ETHERSCAN_API_KEY}`,
                parser: parseBscScanResponse
            }
        ];

        for (const api of apis) {
            let retries = 0;
            while (retries < CONFIG.MAX_API_RETRIES) {
                try {
                    logger.info(`[BSC] Consultando ${api.name} (Intento ${retries + 1})`);
                    
                    const response = await fetch(api.url, {
                        headers: {
                            'User-Agent': 'PaymentListener/1.0'
                        },
                        timeout: CONFIG.API_TIMEOUT
                    });

                    if (!response.ok) {
                        logger.warn(`[BSC] Error en ${api.name}`, { status: response.status });
                        retries++;
                        continue;
                    }

                    const data = await response.json();
                    const transactions = api.parser(data);
                    
                    if (transactions.length > 0) {
                        logger.info(`[BSC] ${api.name}: ${transactions.length} transacciones encontradas`);
                        
                        for (const tx of transactions) {
                            const { data: existingTx, error: txError } = await supabase
                                .from('payment_orders')
                                .select('id')
                                .eq('transaction_hash', tx.hash)
                                .single();

                            if (txError && txError.code !== 'PGRST116') {
                                logger.error('[BSC] Error verificando hash existente', { hash: tx.hash, error: txError.message });
                                continue;
                            }

                            if (existingTx) {
                                logger.warn('[BSC] Hash ya procesado, omitiendo', { hash: tx.hash });
                                continue;
                            }
                            
                            logger.info(`[BSC] Verificando transacción: ${tx.amount} USDT`, { hash: tx.hash });
                            
                            const matchingOrder = validOrders.find(order => 
                                Math.abs(order.amount - tx.amount) < CONFIG.TOLERANCE
                            );

                            if (!matchingOrder) {
                                logger.warn('[BSC] No se encontró orden coincidente para monto', { amount: tx.amount });
                                continue;
                            }

                            const orderCreatedAt = new Date(matchingOrder.created_at).getTime();
                            const txTimestamp = tx.timestamp * 1000; // Convertir a ms si es en segundos
                            if (txTimestamp < (orderCreatedAt - CONFIG.TIMESTAMP_MARGIN)) {
                                logger.warn('[BSC] Transacción antigua, omitiendo', { hash: tx.hash, tx_timestamp: txTimestamp, order_created: orderCreatedAt });
                                continue;
                            }

                            logger.info(`[BSC] Pago detectado para orden ${matchingOrder.id}`, {
                                amount: tx.amount,
                                user_id: matchingOrder.user_id,
                                hash: tx.hash
                            });
                            
                            await activateUser(matchingOrder.user_id, tx.hash, 'BSC', tx.amount);
                            await sendPaymentNotification(matchingOrder, { hash: tx.hash, amount: tx.amount }, 'BSC');
                        }
                    } else {
                        logger.info('[BSC] No hay transacciones recientes');
                    }
                    pollingFailed = false;
                } catch (error) {
                    logger.error('[BSC] Error en verificación de pagos', { error: error.message });
                }
            }
        }
    } catch (error) {
        logger.error('[BSC] Error en verificación de pagos', { error: error.message });
    }

    if (pollingFailed) {
        logger.warn('[BSC] Polling falló, cayendo a webhook backup');
    }
}

/**
 * Parsers para diferentes APIs
 */
function parseTronGridResponse(data) {
    if (!data.data) return [];
    
    return data.data
        .filter(tx => 
            tx.token_info?.address === TRON_USDT_CONTRACT &&
            tx.to === TRON_TREASURY_ADDRESS
        )
        .map(tx => ({
            amount: parseInt(tx.value) / Math.pow(10, tx.token_info.decimals || 6),
            hash: tx.transaction_id,
            timestamp: tx.block_timestamp, // ms
            from: tx.from
        }));
}

function parseBscScanResponse(data) {
    if (!data.result || data.status !== '1') return [];
    
    return data.result
        .filter(tx => 
            tx.contractAddress.toLowerCase() === BSC_USDT_CONTRACT.toLowerCase() &&
            tx.to.toLowerCase() === BSC_TREASURY_ADDRESS.toLowerCase() &&
            tx.tokenSymbol === 'USDT'
        )
        .map(tx => ({
            amount: parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal)),
            hash: tx.hash,
            timestamp: parseInt(tx.timeStamp) * 1000, // Convertir a ms
            from: tx.from
        }));
}

/**
 * Activación de usuario
 */
async function activateUser(userId, transactionHash, network, amount) {
    const startTime = Date.now();
    logger.info(`Activando usuario ${userId} en ${network}`);
    
    try {
        const { data: currentUser, error: fetchError } = await supabase
            .from('users')
            .select('id, status, username')
            .eq('id', userId)
            .single();

        if (fetchError) throw fetchError;

        if (currentUser?.status === 'activo') {
            logger.warn(`Usuario ${userId} ya está activo`, { username: currentUser.username });
            return;
        }

        const { error: userError } = await supabase
            .from('users')
            .update({ status: 'activo' })
            .eq('id', userId);
            
        if (userError) throw userError;

        const { error: orderError } = await supabase
            .from('payment_orders')
            .update({ 
                status: 'completed', 
                transaction_hash: transactionHash,
                network: network,
                completed_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('status', 'pending');
            
        if (orderError) throw orderError;

        const duration = Date.now() - startTime;
        logger.info(`Activación exitosa para usuario ${userId}`, {
            username: currentUser.username,
            amount: amount,
            network: network,
            hash: transactionHash,
            duration_ms: duration
        });

    } catch (error) {
        logger.error(`Error activando usuario ${userId}`, { error: error.message });
    }
}

/**
 * Notificaciones
 */
async function sendPaymentNotification(order, transaction, network) {
    try {
        logger.info(`Notificación: Pago recibido para usuario ${order.user_id}`, {
            amount: transaction.amount,
            network: network,
            hash: transaction.hash
        });
    } catch (error) {
        logger.error('Error enviando notificación', { error: error.message });
    }
}

/**
 * Marcar órdenes expiradas
 */
async function markExpiredOrders() {
    try {
        const fifteenMinutesAgo = new Date(Date.now() - CONFIG.DEFAULT_EXPIRATION_MINUTES * 60 * 1000);
        
        const { data, error } = await supabase
            .from('payment_orders')
            .update({ status: 'expired' })
            .eq('status', 'pending')
            .lt('created_at', fifteenMinutesAgo.toISOString());
        
        if (error) throw error;

        if (data && data.length > 0) {
            logger.info(`${data.length} órdenes marcadas como expiradas`);
        }
    } catch (error) {
        logger.error('Error marcando órdenes expiradas', { error: error.message });
    }
}

/**
 * Función principal del listener
 */
function startListener() {
    logger.info(`Iniciando Listener en modo ${CONFIG.TESTING_MODE ? 'TESTING' : 'PRODUCCIÓN'}`, {
        interval: `${CONFIG.POLL_INTERVAL/1000}s`,
        base_amount: `${CONFIG.BASE_AMOUNT} USDT`,
        tolerance: `${CONFIG.TOLERANCE} USDT`
    });
    
    const runChecks = async () => {
        const cycleStart = Date.now();
        logger.info(`Iniciando nuevo ciclo de verificación`);
        
        await Promise.allSettled([
            markExpiredOrders(),
            checkTronPayments(),
            checkBscPayments()
        ]);
        
        const cycleDuration = Date.now() - cycleStart;
        logger.info(`Ciclo completado`, { duration_ms: cycleDuration });
    };

    setTimeout(runChecks, 5000);
    setInterval(runChecks, CONFIG.POLL_INTERVAL);
    
    logger.info(`Listener iniciado correctamente`);
}

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason: reason.message || reason });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message });
});

module.exports = { startListener };
