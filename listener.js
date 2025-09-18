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
const TRON_USDT_CONTRACT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkM3Uo';

// Configurar TronWeb para Nile Testnet
const tronWeb = new TronWeb({
    fullHost: 'https://nile.trongrid.io',
    headers: { "TRON-PRO-API-KEY": TRONGRID_API_KEY },
    privateKey: '01' // Clave dummy, solo para lectura
});

console.log('🚀 Listener con TronWeb configurado');

// Almacenar transacciones ya procesadas
const processedTransactions = new Set();

/**
 * NUEVA FUNCIÓN: Usar TronWeb directamente
 */
async function checkTronPayments() {
    console.log('[TRON] 🔍 Iniciando chequeo con TronWeb...');
    
    try {
        // Obtener órdenes pendientes
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[TRON] ⚪ No hay órdenes pendientes.');
            return;
        }

        console.log(`[TRON] 📋 Órdenes pendientes: ${pendingOrders.length}`);
        pendingOrders.forEach(order => {
            console.log(`   👤 Usuario ${order.user_id}: ${order.amount} USDT (creada: ${order.created_at})`);
        });

        // Obtener transacciones usando TronWeb
        const transactions = await getTronTransactionsWithTronWeb();
        
        if (transactions.length > 0) {
            console.log(`[TRON] 💰 Transacciones encontradas: ${transactions.length}`);
            
            for (const tx of transactions) {
                // Evitar procesar transacciones ya procesadas
                if (processedTransactions.has(tx.hash)) {
                    console.log(`[TRON] ⏭️ Transacción ya procesada: ${tx.hash}`);
                    continue;
                }
                
                console.log(`[TRON] 🔍 Analizando: ${tx.amount} USDT (${tx.hash})`);
                
                const matchingOrder = pendingOrders.find(order => {
                    const diff = Math.abs(order.amount - tx.amount);
                    console.log(`   📊 Comparando ${order.amount} vs ${tx.amount}, diff: ${diff}`);
                    return diff < 0.01;
                });

                if (matchingOrder) {
                    console.log(`[TRON] 🎉 ¡COINCIDENCIA ENCONTRADA!`);
                    console.log(`   💵 Monto: ${tx.amount} USDT`);
                    console.log(`   👤 Usuario: ${matchingOrder.user_id}`);
                    console.log(`   🔗 Hash: ${tx.hash}`);
                    
                    // Marcar como procesada
                    processedTransactions.add(tx.hash);
                    
                    // Activar usuario
                    await activateUser(matchingOrder.user_id, tx.hash);
                } else {
                    console.log(`[TRON] ❌ No hay coincidencia para ${tx.amount} USDT`);
                }
            }
        } else {
            console.log('[TRON] 📭 No se encontraron transacciones USDT.');
        }

    } catch (error) {
        console.error('[TRON] ❌ Error:', error.message);
        
        // Fallback: usar API REST como respaldo
        console.log('[TRON] 🔄 Intentando con API REST...');
        await checkTronPaymentsAPIFallback();
    }
}

/**
 * Obtener transacciones usando TronWeb directamente
 */
async function getTronTransactionsWithTronWeb() {
    try {
        console.log('[TRON] 📡 Consultando con TronWeb...');
        
        // Obtener información de la cuenta
        const accountInfo = await tronWeb.trx.getAccount(TRON_TREASURY_ADDRESS);
        console.log(`[TRON] 📋 Cuenta encontrada: ${accountInfo.address ? 'Sí' : 'No'}`);

        // Obtener las últimas transacciones
        const transactions = await tronWeb.trx.getTransactionsFromAddress(TRON_TREASURY_ADDRESS, 30, 0);
        console.log(`[TRON] 📦 Transacciones obtenidas: ${transactions.length}`);

        const usdtTransactions = [];

        for (const tx of transactions) {
            try {
                // Verificar si es una transacción de contrato
                if (tx.raw_data && tx.raw_data.contract && tx.raw_data.contract.length > 0) {
                    const contract = tx.raw_data.contract[0];
                    
                    // Verificar si es TriggerSmartContract (TRC20)
                    if (contract.type === 'TriggerSmartContract') {
                        const contractAddress = tronWeb.address.fromHex(contract.parameter.value.contract_address);
                        
                        // Verificar si es el contrato USDT
                        if (contractAddress === TRON_USDT_CONTRACT) {
                            console.log(`[TRON] 🔍 Transacción TRC20 USDT encontrada: ${tx.txID}`);
                            
                            // Decodificar los datos de la transacción
                            const data = contract.parameter.value.data;
                            if (data && data.startsWith('a9059cbb')) { // transfer function signature
                                try {
                                    // Extraer el valor (últimos 64 caracteres)
                                    const valueHex = data.substring(data.length - 64);
                                    const value = parseInt(valueHex, 16);
                                    const amount = value / 1000000; // USDT tiene 6 decimales
                                    
                                    if (amount > 0) {
                                        usdtTransactions.push({
                                            hash: tx.txID,
                                            amount: amount,
                                            timestamp: tx.raw_data.timestamp,
                                            blockNumber: tx.blockNumber || 0
                                        });
                                        
                                        console.log(`[TRON] ✅ USDT Transfer: ${amount} USDT`);
                                    }
                                } catch (decodeError) {
                                    console.log(`[TRON] ⚠️ Error decodificando: ${decodeError.message}`);
                                }
                            }
                        }
                    }
                }
            } catch (txError) {
                console.log(`[TRON] ⚠️ Error procesando tx: ${txError.message}`);
                continue;
            }
        }

        return usdtTransactions;

    } catch (error) {
        console.error('[TRON] ❌ Error con TronWeb:', error.message);
        return [];
    }
}

/**
 * Función de respaldo con API REST
 */
async function checkTronPaymentsAPIFallback() {
    try {
        // Usar un endpoint más básico que suele funcionar
        const apiUrl = `https://api.nile.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions?limit=20&only_confirmed=true`;
        
        const response = await fetch(apiUrl, {
            headers: {
                'Content-Type': 'application/json',
                'TRON-PRO-API-KEY': TRONGRID_API_KEY
            }
        });

        if (response.ok) {
            const data = await response.json();
            console.log(`[TRON] 🔄 API Fallback: ${data.data ? data.data.length : 0} transacciones`);
            
            // Procesar datos similares a TronWeb
            // (implementación simplificada)
        } else {
            console.log(`[TRON] ❌ API Fallback falló: ${response.status}`);
        }

    } catch (error) {
        console.log(`[TRON] ❌ API Fallback error: ${error.message}`);
    }
}

/**
 * Función BSC (sin cambios)
 */
async function checkBscPayments() {
    console.log('[BSC] 🔍 Iniciando chequeo...');

    if (!ETHERSCAN_API_KEY) {
        console.log('[BSC] ❌ ETHERSCAN_API_KEY no disponible.');
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
 * Activar usuario mejorada con más debugging
 */
async function activateUser(userId, transactionHash) {
    console.log(`🔄 INICIANDO ACTIVACIÓN - Usuario: ${userId}`);
    console.log(`🔗 Hash de transacción: ${transactionHash}`);
    
    try {
        // Verificar estado actual del usuario
        const { data: currentUser, error: fetchError } = await supabase
            .from('users')
            .select('id, status')
            .eq('id', userId)
            .single();

        if (fetchError) {
            console.error(`❌ Error obteniendo usuario ${userId}:`, fetchError.message);
            throw fetchError;
        }

        console.log(`📋 Estado actual del usuario ${userId}: ${currentUser?.status || 'NO ENCONTRADO'}`);

        if (currentUser?.status === 'activo') {
            console.log(`⚠️ Usuario ${userId} YA está activo. Saltando activación.`);
            return;
        }

        // Activar usuario
        console.log(`🔄 Actualizando usuario ${userId} a estado 'activo'...`);
        const { data: updatedUser, error: userError } = await supabase
            .from('users')
            .update({ status: 'activo' })
            .eq('id', userId)
            .select();
            
        if (userError) {
            console.error(`❌ Error actualizando usuario:`, userError.message);
            throw userError;
        }

        console.log(`✅ Usuario actualizado:`, updatedUser);

        // Completar orden de pago
        console.log(`🔄 Completando orden de pago para usuario ${userId}...`);
        const { data: updatedOrder, error: orderError } = await supabase
            .from('payment_orders')
            .update({ 
                status: 'completed', 
                transaction_hash: transactionHash 
            })
            .eq('user_id', userId)
            .eq('status', 'pending')
            .select();
            
        if (orderError) {
            console.error(`❌ Error actualizando orden:`, orderError.message);
            throw orderError;
        }

        console.log(`✅ Orden completada:`, updatedOrder);

        console.log(`🎉 ¡ACTIVACIÓN EXITOSA!`);
        console.log(`   👤 Usuario: ${userId}`);
        console.log(`   🔗 Hash: ${transactionHash}`);
        console.log(`   ⏰ Procesado: ${new Date().toISOString()}`);
        
    } catch (error) {
        console.error(`💥 ERROR CRÍTICO activando usuario ${userId}:`, error);
        console.error(`   Mensaje: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);
    }
}

/**
 * Función principal del listener
 */
function startListener() {
    const interval = 15000; // 15 segundos
    console.log(`🚀 Iniciando listener cada ${interval/1000} segundos`);
    
    const runChecks = async () => {
        console.log('\n🔄 ============ NUEVO CICLO ============');
        const start = Date.now();
        
        await Promise.allSettled([
            checkTronPayments(),
            checkBscPayments()
        ]);
        
        console.log(`⏱️ Ciclo completado en ${Date.now() - start}ms`);
        console.log('🔄 ====================================\n');
    };

    // Primer chequeo después de 3 segundos
    setTimeout(runChecks, 3000);
    
    // Chequeos periódicos
    setInterval(runChecks, interval);
    
    console.log('✅ Listener iniciado correctamente!');
}

module.exports = { startListener };
