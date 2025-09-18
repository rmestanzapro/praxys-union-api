// listener.js

const TronWeb = require('tronweb');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Inicialización de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN ---
const TRON_TREASURY_ADDRESS = 'TB3idCQ8aojaeMx9kdudp6vgN3TWJFdrTW';
const BSC_TREASURY_ADDRESS = '0xa92dD1DdE84Ec6Ea88733dd290F40186bbb1dD74';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
const TRON_USDT_CONTRACT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkM3Uo'; // USDT en Nile testnet

console.log('🚀 Listener de pagos multi-cadena configurado.');

// --- VERIFICACIÓN DE VARIABLES DE ENTORNO ---
if (!TRONGRID_API_KEY) {
    console.error('❌ ERROR: TRONGRID_API_KEY no está definida.');
} else {
    console.log('✅ TRONGRID_API_KEY cargada.');
}

/**
 * NUEVA FUNCIÓN MEJORADA PARA TRON - Múltiples APIs de respaldo
 */
async function checkTronPayments() {
    console.log('[TRON] 🔍 Iniciando chequeo...');
    
    try {
        // Verificar órdenes pendientes
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[TRON] ⚪ No hay órdenes pendientes.');
            return;
        }
        
        console.log(`[TRON] 📋 Órdenes pendientes encontradas: ${pendingOrders.length}`);
        pendingOrders.forEach(order => {
            console.log(`   👤 Usuario ${order.user_id}: ${order.amount} USDT`);
        });

        // INTENTAR MÚLTIPLES APIs EN ORDEN DE PRIORIDAD
        const results = await tryMultipleTronAPIs();
        
        if (results && results.length > 0) {
            console.log(`[TRON] 💰 Transacciones encontradas: ${results.length}`);
            
            for (const tx of results) {
                console.log(`[TRON] 🔍 Analizando transacción: ${tx.amount} USDT`);
                
                const matchingOrder = pendingOrders.find(order => {
                    const diff = Math.abs(order.amount - tx.amount);
                    console.log(`   📊 Comparando ${order.amount} vs ${tx.amount}, diff: ${diff}`);
                    return diff < 0.01; // Tolerancia de 1 centavo
                });

                if (matchingOrder) {
                    console.log(`[TRON] 🎉 ¡COINCIDENCIA ENCONTRADA!`);
                    console.log(`   💵 Monto: ${tx.amount} USDT`);
                    console.log(`   👤 Usuario: ${matchingOrder.user_id}`);
                    console.log(`   🔗 Hash: ${tx.hash}`);
                    
                    await activateUser(matchingOrder.user_id, tx.hash);
                } else {
                    console.log(`[TRON] ❌ No hay coincidencia para ${tx.amount} USDT`);
                }
            }
        } else {
            console.log('[TRON] 📭 No se encontraron transacciones.');
        }
        
    } catch (error) {
        console.error('[TRON] ❌ Error:', error.message);
    }
}

/**
 * Función que intenta múltiples APIs de TRON
 */
async function tryMultipleTronAPIs() {
    const apis = [
        {
            name: 'TronGrid Official',
            url: `https://api.nileapi.tronscan.io/api/token_trc20/transfers?limit=20&start=0&sort=-timestamp&relatedAddress=${TRON_TREASURY_ADDRESS}`,
            parser: parseTronScanResponse
        },
        {
            name: 'TronGrid Alternative',
            url: `https://nileapi.tronscan.org/api/token_trc20/transfers?limit=20&relatedAddress=${TRON_TREASURY_ADDRESS}&filterTokenValue=0`,
            parser: parseTronScanResponse
        },
        {
            name: 'Direct TronGrid',
            url: `https://api.nile.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions?limit=20`,
            parser: parseTronGridResponse
        }
    ];

    for (const api of apis) {
        try {
            console.log(`[TRON] 🔄 Probando ${api.name}...`);
            
            const response = await fetch(api.url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...(TRONGRID_API_KEY && { 'TRON-PRO-API-KEY': TRONGRID_API_KEY })
                },
                timeout: 15000
            });

            if (!response.ok) {
                console.log(`[TRON] ⚠️ ${api.name} falló: ${response.status}`);
                continue;
            }

            const data = await response.json();
            console.log(`[TRON] ✅ ${api.name} respondió exitosamente`);
            
            const results = api.parser(data);
            if (results && results.length > 0) {
                console.log(`[TRON] 📦 ${api.name} encontró ${results.length} transacciones`);
                return results;
            }
            
        } catch (error) {
            console.log(`[TRON] ❌ Error en ${api.name}: ${error.message}`);
            continue;
        }
    }
    
    return [];
}

/**
 * Parser para respuestas de TronScan
 */
function parseTronScanResponse(data) {
    if (!data.token_transfers) return [];
    
    return data.token_transfers
        .filter(tx => 
            tx.contractAddress === TRON_USDT_CONTRACT && 
            tx.to_address === TRON_TREASURY_ADDRESS
        )
        .map(tx => ({
            amount: parseFloat(tx.quant) / Math.pow(10, tx.tokenInfo?.tokenDecimal || 6),
            hash: tx.transaction_id,
            from: tx.from_address,
            timestamp: tx.block_timestamp
        }));
}

/**
 * Parser para respuestas de TronGrid
 */
function parseTronGridResponse(data) {
    if (!data.data) return [];
    
    const results = [];
    
    for (const tx of data.data) {
        // Buscar en los logs por transfers TRC20
        if (tx.log) {
            for (const log of tx.log) {
                if (log.address === TRON_USDT_CONTRACT && 
                    log.topics && 
                    log.topics[0] === 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                    
                    try {
                        const valueHex = log.data;
                        const amount = parseInt(valueHex, 16) / 1000000; // USDT 6 decimales
                        
                        results.push({
                            amount: amount,
                            hash: tx.txID,
                            from: tx.raw_data?.contract?.[0]?.parameter?.value?.owner_address,
                            timestamp: tx.block_timestamp
                        });
                    } catch (e) {
                        console.log('[TRON] ⚠️ Error parseando log:', e.message);
                    }
                }
            }
        }
    }
    
    return results;
}

/**
 * Función de BSC (sin cambios)
 */
async function checkBscPayments() {
    console.log('[BSC] 🔍 Iniciando chequeo...');

    if (!ETHERSCAN_API_KEY) {
        console.error('[BSC] ❌ ETHERSCAN_API_KEY no disponible.');
        return;
    }

    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount')
            .eq('status', 'pending');
            
        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[BSC] ⚪ No hay órdenes pendientes.');
            return;
        }

        const apiUrl = `https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=${BSC_TREASURY_ADDRESS}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
        
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`BscScan error: ${response.statusText}`);
        
        const data = await response.json();
        if (data.status === "1" && data.result.length > 0) {
            console.log(`[BSC] 💰 Encontradas ${data.result.length} transacciones`);
            
            for (const tx of data.result) {
                const amount_paid = parseFloat(ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal)));
                const matchingOrder = pendingOrders.find(order => Math.abs(order.amount - amount_paid) < 0.01);
                
                if (matchingOrder) {
                    console.log(`[BSC] 🎉 Coincidencia: ${amount_paid}, Usuario: ${matchingOrder.user_id}`);
                    await activateUser(matchingOrder.user_id, tx.hash);
                }
            }
        }
    } catch (error) {
        console.error('[BSC] ❌ Error:', error.message);
    }
}

/**
 * Función de activación de usuario
 */
async function activateUser(userId, transactionHash) {
    console.log(`🔄 Activando usuario ${userId}...`);
    
    try {
        // Verificar si ya está activo
        const { data: user } = await supabase
            .from('users')
            .select('status')
            .eq('id', userId)
            .single();

        if (user?.status === 'activo') {
            console.log(`⚠️ Usuario ${userId} ya está activo.`);
            return;
        }

        // Activar usuario
        const { error: userError } = await supabase
            .from('users')
            .update({ status: 'activo' })
            .eq('id', userId);
            
        if (userError) throw userError;

        // Completar orden
        const { error: orderError } = await supabase
            .from('payment_orders')
            .update({ 
                status: 'completed', 
                transaction_hash: transactionHash 
            })
            .eq('user_id', userId);
            
        if (orderError) throw orderError;

        console.log(`✅ Usuario ${userId} activado exitosamente!`);
        console.log(`🔗 Hash: ${transactionHash}`);
        
    } catch (error) {
        console.error(`❌ Error activando usuario ${userId}:`, error.message);
    }
}

/**
 * Función principal del listener
 */
function startListener() {
    const interval = 20000; // 20 segundos
    console.log(`🚀 Iniciando listeners cada ${interval/1000} segundos`);
    
    const runChecks = async () => {
        console.log('\n🔄 --- NUEVO CICLO ---');
        const start = Date.now();
        
        await Promise.allSettled([
            checkTronPayments(),
            checkBscPayments()
        ]);
        
        console.log(`⏱️ Ciclo completado en ${Date.now() - start}ms\n`);
    };

    // Primer chequeo después de 3 segundos
    setTimeout(runChecks, 3000);
    
    // Chequeos periódicos
    setInterval(runChecks, interval);
    
    console.log('✅ Listener iniciado correctamente!');
}

module.exports = { startListener };
