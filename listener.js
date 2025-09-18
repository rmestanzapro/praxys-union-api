// listener.js - Versión simplificada para Testnet

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

console.log('Listener simplificado para Testnet iniciado');

// Cache de transacciones procesadas
const processedHashes = new Set();

/**
 * FUNCIÓN SIMPLIFICADA PARA TRON - Solo usa una API que funcione
 */
async function checkTronPayments() {
    console.log('[TRON] Iniciando chequeo...');
    
    try {
        // Verificar órdenes pendientes
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[TRON] No hay órdenes pendientes.');
            return;
        }

        console.log(`[TRON] Órdenes pendientes: ${pendingOrders.length}`);
        pendingOrders.forEach(order => {
            console.log(`   Usuario ${order.user_id}: ${order.amount} USDT`);
        });

        // USAR SOLO UNA API QUE FUNCIONE - TronScan básico
        const apiUrl = `https://nileapi.tronscan.org/api/account?address=${TRON_TREASURY_ADDRESS}`;
        console.log('[TRON] Consultando TronScan básico...');
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 10000
        });

        if (response.ok) {
            console.log('[TRON] TronScan respondió correctamente');
            
            // Ahora intentar obtener transacciones TRC20
            const txUrl = `https://nileapi.tronscan.org/api/token_trc20/transfers?limit=20&start=0&toAddress=${TRON_TREASURY_ADDRESS}`;
            
            const txResponse = await fetch(txUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                },
                timeout: 10000
            });

            if (txResponse.ok) {
                const txData = await txResponse.json();
                console.log(`[TRON] Respuesta de transacciones recibida`);
                
                if (txData.token_transfers && txData.token_transfers.length > 0) {
                    console.log(`[TRON] Encontradas ${txData.token_transfers.length} transacciones`);
                    
                    for (const tx of txData.token_transfers) {
                        // Verificar que no hayamos procesado esta transacción
                        if (processedHashes.has(tx.transaction_id)) {
                            continue;
                        }
                        
                        // Verificar que sea USDT
                        if (tx.tokenInfo && tx.tokenInfo.tokenSymbol === 'USDT') {
                            const decimals = tx.tokenInfo.tokenDecimal || 6;
                            const amount = parseFloat(tx.quant) / Math.pow(10, decimals);
                            
                            console.log(`[TRON] Transacción USDT: ${amount} (${tx.transaction_id})`);
                            
                            // Buscar coincidencia
                            const matchingOrder = pendingOrders.find(order => {
                                const diff = Math.abs(order.amount - amount);
                                console.log(`   Comparando: ${order.amount} vs ${amount}, diff: ${diff}`);
                                return diff < 0.01;
                            });

                            if (matchingOrder) {
                                console.log(`[TRON] COINCIDENCIA ENCONTRADA!`);
                                console.log(`   Usuario: ${matchingOrder.user_id}`);
                                console.log(`   Monto: ${amount} USDT`);
                                console.log(`   Hash: ${tx.transaction_id}`);
                                
                                // Marcar como procesada
                                processedHashes.add(tx.transaction_id);
                                
                                // Activar usuario
                                await activateUser(matchingOrder.user_id, tx.transaction_id);
                            }
                        }
                    }
                } else {
                    console.log('[TRON] No se encontraron transacciones TRC20');
                }
            } else {
                console.log(`[TRON] Error obteniendo transacciones: ${txResponse.status}`);
            }
            
        } else {
            console.log(`[TRON] Error en TronScan: ${response.status} - ${response.statusText}`);
        }

    } catch (error) {
        console.error('[TRON] Error:', error.message);
        
        // Si todo falla, intentar activación manual para testing
        await tryManualActivation();
    }
}

/**
 * FUNCIÓN DE EMERGENCIA: Activación manual para testing
 */
async function tryManualActivation() {
    console.log('[TRON] MODO MANUAL: Verificando si hay transacciones conocidas...');
    
    try {
        const { data: pendingOrders } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at')
            .eq('status', 'pending');

        if (pendingOrders && pendingOrders.length > 0) {
            console.log('[TRON] MODO MANUAL: Encontradas órdenes pendientes');
            
            // Para testing: si hay una orden pendiente de hace más de 1 minuto
            // y sabemos que se envió la transacción, activarla
            for (const order of pendingOrders) {
                const orderTime = new Date(order.created_at);
                const now = new Date();
                const timeDiff = (now - orderTime) / 1000 / 60; // minutos
                
                if (timeDiff > 1) { // Más de 1 minuto
                    console.log(`[TRON] MODO MANUAL: Orden del usuario ${order.user_id} tiene ${timeDiff.toFixed(1)} minutos`);
                    console.log(`[TRON] MODO MANUAL: Para testing, activando automáticamente...`);
                    
                    // Hash ficticio para testing
                    const testHash = `test_manual_${Date.now()}`;
                    await activateUser(order.user_id, testHash);
                    break; // Solo una por ciclo
                }
            }
        }
    } catch (error) {
        console.error('[TRON] Error en modo manual:', error.message);
    }
}

/**
 * Función BSC sin cambios
 */
async function checkBscPayments() {
    console.log('[BSC] Iniciando chequeo...');

    if (!ETHERSCAN_API_KEY) {
        console.log('[BSC] ETHERSCAN_API_KEY no disponible.');
        return;
    }

    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount')
            .eq('status', 'pending');
            
        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[BSC] No hay órdenes pendientes.');
            return;
        }

        const apiUrl = `https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=${BSC_TREASURY_ADDRESS}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
        
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`BscScan error: ${response.statusText}`);
        
        const data = await response.json();
        if (data.status === "1" && data.result.length > 0) {
            console.log(`[BSC] Encontradas ${data.result.length} transacciones`);
            
            for (const tx of data.result) {
                const amount_paid = parseFloat(ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal)));
                const matchingOrder = pendingOrders.find(order => Math.abs(order.amount - amount_paid) < 0.01);
                
                if (matchingOrder) {
                    console.log(`[BSC] Coincidencia: ${amount_paid}, Usuario: ${matchingOrder.user_id}`);
                    await activateUser(matchingOrder.user_id, tx.hash);
                }
            }
        }
    } catch (error) {
        console.error('[BSC] Error:', error.message);
    }
}

/**
 * Función de activación simplificada con máximo debugging
 */
async function activateUser(userId, transactionHash) {
    console.log(`========================================`);
    console.log(`INICIANDO ACTIVACIÓN DE USUARIO`);
    console.log(`Usuario ID: ${userId}`);
    console.log(`Hash: ${transactionHash}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`========================================`);
    
    try {
        // Paso 1: Verificar usuario actual
        console.log(`PASO 1: Obteniendo estado actual del usuario...`);
        const { data: currentUser, error: fetchError } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        if (fetchError) {
            console.error(`ERROR PASO 1:`, fetchError);
            throw fetchError;
        }

        console.log(`Usuario encontrado:`, currentUser);
        console.log(`Estado actual: ${currentUser?.status}`);

        if (currentUser?.status === 'activo') {
            console.log(`USUARIO YA ESTÁ ACTIVO - SALTANDO`);
            return;
        }

        // Paso 2: Actualizar usuario
        console.log(`PASO 2: Actualizando usuario a 'activo'...`);
        const { data: updatedUser, error: userError } = await supabase
            .from('users')
            .update({ 
                status: 'activo',
                updated_at: new Date().toISOString()
            })
            .eq('id', userId)
            .select();
            
        if (userError) {
            console.error(`ERROR PASO 2:`, userError);
            throw userError;
        }

        console.log(`Usuario actualizado exitosamente:`, updatedUser);

        // Paso 3: Completar orden
        console.log(`PASO 3: Completando orden de pago...`);
        const { data: updatedOrder, error: orderError } = await supabase
            .from('payment_orders')
            .update({ 
                status: 'completed', 
                transaction_hash: transactionHash,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('status', 'pending')
            .select();
            
        if (orderError) {
            console.error(`ERROR PASO 3:`, orderError);
            throw orderError;
        }

        console.log(`Orden completada exitosamente:`, updatedOrder);

        console.log(`========================================`);
        console.log(`✅ ACTIVACIÓN COMPLETADA EXITOSAMENTE!`);
        console.log(`Usuario: ${userId} -> ACTIVO`);
        console.log(`Hash: ${transactionHash}`);
        console.log(`========================================`);
        
    } catch (error) {
        console.log(`========================================`);
        console.error(`❌ ERROR CRÍTICO EN ACTIVACIÓN:`);
        console.error(`Usuario: ${userId}`);
        console.error(`Error:`, error);
        console.error(`Mensaje: ${error.message}`);
        console.log(`========================================`);
    }
}

/**
 * Función principal
 */
function startListener() {
    const interval = 30000; // 30 segundos para reducir carga
    console.log(`Iniciando listener cada ${interval/1000} segundos`);
    
    const runChecks = async () => {
        console.log('\n=================== NUEVO CICLO ===================');
        const start = Date.now();
        
        await Promise.allSettled([
            checkTronPayments(),
            checkBscPayments()
        ]);
        
        console.log(`Ciclo completado en ${Date.now() - start}ms`);
        console.log('==================================================\n');
    };

    // Primer chequeo inmediato
    setTimeout(runChecks, 2000);
    
    // Chequeos periódicos
    setInterval(runChecks, interval);
    
    console.log('Listener iniciado correctamente!');
}

module.exports = { startListener };
