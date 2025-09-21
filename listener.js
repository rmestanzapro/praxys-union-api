const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

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

console.log('🚀 LISTENER PRODUCCIÓN - MAINNET INICIADO');
console.log(`📍 TRON Treasury: ${TRON_TREASURY_ADDRESS}`);
console.log(`📍 BSC Treasury: ${BSC_TREASURY_ADDRESS}`);

// Cache de transacciones procesadas
const processedHashes = new Set();

// Configuración flexible para testing
const CONFIG = {
    TESTING_MODE: process.env.TESTING_MODE === "true",
    BASE_AMOUNT: process.env.TESTING_MODE === "true" ? 1 : 15, // Base para logs
    TOLERANCE: 0.01, // Siempre 0.01 para capturar monto único + variaciones
    POLL_INTERVAL: process.env.TESTING_MODE === "true" ? 5000 : 10000,
    API_TIMEOUT: 15000,
    MAX_API_RETRIES: 3,
};

console.log(`🔧 Modo: ${CONFIG.TESTING_MODE ? '🧪 TESTING' : '🚀 PRODUCCIÓN'}`);
console.log(`💰 Monto base: ${CONFIG.BASE_AMOUNT} USDT (con ajuste aleatorio ~${CONFIG.BASE_AMOUNT}.00xxx)`);

/**
 * TRON MAINNET
 */
async function checkTronPayments() {
    console.log(`[TRON] 🔍 Verificando pagos ${CONFIG.TESTING_MODE ? `(Testing: ~${CONFIG.BASE_AMOUNT}.00xxx USDT)` : '(Producción)'}...`);
    
    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at, id')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders?.length) {
            console.log('[TRON] ⚪ Sin órdenes pendientes');
            return;
        }

        // Filtrar solo órdenes válidas (todas en producción; en testing, todas ya que montos ~1.xx)
        const validOrders = pendingOrders; // No filtro extra; usa tolerancia para unicidad

        if (validOrders.length === 0) {
            console.log(`[TRON] ⚠️ No hay órdenes pendientes`);
            return;
        }

        // APIs de mainnet
        const apis = [
            {
                name: 'TronScan Mainnet',
                url: `https://apilist.tronscan.org/api/token_trc20/transfers?limit=50&start=0&sort=-timestamp&toAddress=${TRON_TREASURY_ADDRESS}&filterTokenValue=0`,
                parser: parseTronScanResponse
            },
            {
                name: 'TronScan Alt',
                url: `https://api.tronscan.org/api/token_trc20/transfers?limit=50&relatedAddress=${TRON_TREASURY_ADDRESS}&filterTokenValue=0`,
                parser: parseTronScanResponse
            },
            {
                name: 'TronGrid Mainnet',
                url: `https://api.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions/trc20?limit=50&only_to=true`,
                parser: parseTronGridResponse
            }
        ];

        for (const api of apis) {
            let retries = 0;
            while (retries < CONFIG.MAX_API_RETRIES) {
                try {
                    console.log(`[TRON] 🌐 ${api.name} (Intento ${retries + 1})...`);
                    
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
                        console.log(`[TRON] ❌ ${api.name}: ${response.status}`);
                        retries++;
                        continue;
                    }

                    const data = await response.json();
                    const transactions = api.parser(data);
                    
                    if (transactions.length > 0) {
                        console.log(`[TRON] ✅ ${api.name}: ${transactions.length} transacciones`);
                        
                        for (const tx of transactions) {
                            if (processedHashes.has(tx.hash)) {
                                console.log(`[TRON] ⏭️ Ya procesada: ${tx.hash}`);
                                continue;
                            }
                            
                            console.log(`[TRON] 🔍 Verificando: ${tx.amount} USDT`);
                            
                            const matchingOrder = validOrders.find(order => 
                                Math.abs(order.amount - tx.amount) < CONFIG.TOLERANCE
                            );

                            if (matchingOrder) {
                                console.log(`[TRON] 🎉 PAGO DETECTADO!`);
                                console.log(`   💰 Monto: ${tx.amount} USDT (coincide con orden ${matchingOrder.amount})`);
                                console.log(`   👤 Usuario: ${matchingOrder.user_id}`);
                                console.log(`   🆔 Orden: ${matchingOrder.id}`);
                                console.log(`   🔗 Hash: ${tx.hash}`);
                                
                                processedHashes.add(tx.hash);
                                await activateUser(matchingOrder.user_id, tx.hash, 'TRON', tx.amount);
                                
                                await sendPaymentNotification(matchingOrder, tx, 'TRON');
                            } else {
                                console.log(`[TRON] ❌ Sin coincidencia para ${tx.amount} USDT (tolerancia ${CONFIG.TOLERANCE})`);
                            }
                        }
                        
                        return;
                    }
                    break;
                } catch (apiError) {
                    console.log(`[TRON] ❌ Error ${api.name} (Intento ${retries + 1}): ${apiError.message}`);
                    retries++;
                    if (retries >= CONFIG.MAX_API_RETRIES) break;
                }
            }
        }

        console.log('[TRON] 📭 No se encontraron transacciones en ninguna API');

    } catch (error) {
        console.error('[TRON] 💥 Error general:', error.message);
    }
}

/**
 * BSC MAINNET
 */
async function checkBscPayments() {
    console.log(`[BSC] 🔍 Verificando pagos ${CONFIG.TESTING_MODE ? `(Testing: ~${CONFIG.BASE_AMOUNT}.00xxx USDT)` : '(Producción)'}...`);

    if (!ETHERSCAN_API_KEY) {
        console.log('[BSC] ❌ ETHERSCAN_API_KEY requerida');
        return;
    }

    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at, id')
            .eq('status', 'pending');
            
        if (error) throw error;
        if (!pendingOrders?.length) {
            console.log('[BSC] ⚪ Sin órdenes pendientes');
            return;
        }

        const validOrders = pendingOrders; // No filtro extra; usa tolerancia

        if (validOrders.length === 0) {
            console.log(`[BSC] ⚠️ No hay órdenes pendientes`);
            return;
        }

        const apiUrl = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${BSC_USDT_CONTRACT}&address=${BSC_TREASURY_ADDRESS}&page=1&offset=50&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
        
        const response = await fetch(apiUrl, { timeout: CONFIG.API_TIMEOUT });
        if (!response.ok) throw new Error(`BscScan error: ${response.statusText}`);
        
        const data = await response.json();
        if (data.status === "1" && data.result?.length > 0) {
            console.log(`[BSC] ✅ ${data.result.length} transacciones encontradas`);
            
            for (const tx of data.result) {
                if (processedHashes.has(tx.hash)) continue;
                
                const amount = parseFloat(ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal || 18)));
                
                console.log(`[BSC] 🔍 Verificando: ${amount} ${tx.tokenSymbol}`);
                
                const matchingOrder = validOrders.find(order => 
                    Math.abs(order.amount - amount) < CONFIG.TOLERANCE
                );
                
                if (matchingOrder) {
                    console.log(`[BSC] 🎉 PAGO DETECTADO!`);
                    console.log(`   💰 Monto: ${amount} ${tx.tokenSymbol} (coincide con orden ${matchingOrder.amount})`);
                    console.log(`   👤 Usuario: ${matchingOrder.user_id}`);
                    console.log(`   🔗 Hash: ${tx.hash}`);
                    
                    processedHashes.add(tx.hash);
                    await activateUser(matchingOrder.user_id, tx.hash, 'BSC', amount);
                    await sendPaymentNotification(matchingOrder, { hash: tx.hash, amount }, 'BSC');
                }
            }
        } else {
            console.log('[BSC] 📭 No hay transacciones recientes');
        }
    } catch (error) {
        console.error('[BSC] 💥 Error:', error.message);
    }
}

/**
 * Parsers para diferentes APIs
 */
function parseTronScanResponse(data) {
    if (!data.token_transfers) return [];
    
    return data.token_transfers
        .filter(tx => 
            tx.contractAddress === TRON_USDT_CONTRACT && 
            tx.to_address === TRON_TREASURY_ADDRESS &&
            tx.tokenInfo?.tokenSymbol === 'USDT'
        )
        .map(tx => ({
            amount: parseFloat(tx.quant) / Math.pow(10, tx.tokenInfo.tokenDecimal || 6),
            hash: tx.transaction_id,
            timestamp: tx.block_timestamp,
            from: tx.from_address
        }));
}

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
            timestamp: tx.block_timestamp,
            from: tx.from
        }));
}

/**
 * Activación de usuario
 */
async function activateUser(userId, transactionHash, network, amount) {
    const startTime = Date.now();
    console.log(`🔄 ACTIVANDO USUARIO ${userId} (${network})...`);
    
    try {
        const { data: currentUser, error: fetchError } = await supabase
            .from('users')
            .select('id, status, username')
            .eq('id', userId)
            .single();

        if (fetchError) throw fetchError;

        if (currentUser?.status === 'activo') {
            console.log(`⚠️ Usuario ${userId} ya activo`);
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
        console.log(`✅ ACTIVACIÓN EXITOSA (${duration}ms)`);
        console.log(`   👤 Usuario: ${currentUser.username} (ID: ${userId})`);
        console.log(`   💰 Pago: ${amount} USDT via ${network}`);
        console.log(`   🔗 Hash: ${transactionHash}`);

    } catch (error) {
        console.error(`❌ ERROR ACTIVANDO USUARIO ${userId}:`, error.message);
    }
}

/**
 * Notificaciones
 */
async function sendPaymentNotification(order, transaction, network) {
    try {
        console.log(`📧 Notificación: Pago recibido - Usuario ${order.user_id}, ${transaction.amount} USDT via ${network}`);
    } catch (error) {
        console.log('⚠️ Error enviando notificación:', error.message);
    }
}

/**
 * Función principal del listener
 */
function startListener() {
    const mode = CONFIG.TESTING_MODE ? 'TESTING' : 'PRODUCCIÓN';
    console.log(`\n🚀 INICIANDO LISTENER - MODO ${mode}`);
    console.log(`⏰ Intervalo: ${CONFIG.POLL_INTERVAL/1000}s`);
    console.log(`💰 Monto base: ${CONFIG.BASE_AMOUNT} USDT (con ajuste aleatorio)`);
    console.log(`🎯 Tolerancia: ${CONFIG.TOLERANCE} USDT`);
    
    const runChecks = async () => {
        const cycleStart = Date.now();
        console.log('\n' + '='.repeat(50));
        console.log(`🔄 CICLO ${mode} - ${new Date().toISOString()}`);
        console.log('='.repeat(50));
        
        await Promise.allSettled([
            checkTronPayments(),
            checkBscPayments()
        ]);
        
        const cycleDuration = Date.now() - cycleStart;
        console.log(`⏱️ Ciclo completado en ${cycleDuration}ms`);
        console.log('='.repeat(50) + '\n');
    };

    setTimeout(runChecks, 5000);
    setInterval(runChecks, CONFIG.POLL_INTERVAL);
    
    console.log(`✅ Listener ${mode} iniciado correctamente!`);
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
});

module.exports = { startListener };
