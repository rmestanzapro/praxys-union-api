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

console.log('Listener de pagos multi-cadena configurado.');

// --- VERIFICACIÓN DE VARIABLES DE ENTORNO AL ARRANCAR ---
if (!TRONGRID_API_KEY) {
    console.error('ERROR FATAL: La variable de entorno TRONGRID_API_KEY no está definida.');
} else {
    console.log('[TRON] TRONGRID_API_KEY cargada exitosamente.');
}
if (!ETHERSCAN_API_KEY) {
    console.error('ERROR FATAL: La variable de entorno ETHERSCAN_API_KEY no está definida.');
} else {
    console.log('[BSC] ETHERSCAN_API_KEY cargada exitosamente.');
}

/**
 * Busca y procesa pagos pendientes en la red de TRON usando TronScan API
 */
async function checkTronPayments() {
    console.log('[TRON] Iniciando ciclo de chequeo...');
    
    try {
        const { data: pendingOrders, error } = await supabase.from('payment_orders').select('user_id, amount').eq('status', 'pending');
        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[TRON] No se encontraron órdenes pendientes.');
            return;
        }
        console.log(`[TRON] Encontradas ${pendingOrders.length} órdenes pendientes.`);

        // Usar TronScan API para mejor confiabilidad
        const apiUrl = `https://nileapi.tronscan.org/api/token_trc20/transfers?limit=50&start=0&sort=-timestamp&relatedAddress=${TRON_TREASURY_ADDRESS}&filterTokenValue=0&count=true`;
        console.log(`[TRON] Consultando TronScan API...`);
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'PaymentListener/1.0'
            },
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`TronScan API error: ${response.status} - ${response.statusText}`);
        }
        
        const data = await response.json();

        if (data.token_transfers && data.token_transfers.length > 0) {
            console.log(`[TRON] Encontradas ${data.token_transfers.length} transacciones TRC20.`);
            
            for (const transfer of data.token_transfers) {
                // Verificar que sea USDT y transferencia hacia nuestra dirección
                if (transfer.contractAddress === TRON_USDT_CONTRACT && 
                    transfer.to_address === TRON_TREASURY_ADDRESS &&
                    transfer.tokenInfo) {
                    
                    const decimals = transfer.tokenInfo.tokenDecimal || 6;
                    const amount_paid = parseFloat(transfer.quant) / Math.pow(10, decimals);
                    
                    console.log(`[TRON] Transacción USDT encontrada: ${amount_paid} USDT`);
                    
                    // Buscar orden coincidente
                    const matchingOrder = pendingOrders.find(order => 
                        Math.abs(order.amount - amount_paid) < 0.01 // Tolerancia de 1 centavo
                    );

                    if (matchingOrder) {
                        console.log(`[TRON] ¡Coincidencia encontrada! Monto: ${amount_paid}, Usuario ID: ${matchingOrder.user_id}`);
                        await activateUser(matchingOrder.user_id, transfer.transaction_id);
                    }
                }
            }
        } else {
            console.log('[TRON] No se encontraron transacciones TRC20 recientes.');
        }
        
    } catch (error) {
        console.error('[TRON] Error en el listener:', error.message);
        
        // Fallback: Intentar con TronGrid si TronScan falla
        if (TRONGRID_API_KEY) {
            console.log('[TRON] Intentando fallback con TronGrid...');
            await checkTronPaymentsFallback();
        }
    }
}

/**
 * Función de respaldo para TRON usando TronGrid
 */
async function checkTronPaymentsFallback() {
    try {
        const { data: pendingOrders, error } = await supabase.from('payment_orders').select('user_id, amount').eq('status', 'pending');
        if (error || !pendingOrders || pendingOrders.length === 0) return;

        // Usar endpoint más básico y confiable
        const apiUrl = `https://api.nileapi.tronscan.io/api/account?address=${TRON_TREASURY_ADDRESS}&includeToken=true`;
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'TRON-PRO-API-KEY': TRONGRID_API_KEY
            },
            timeout: 8000
        });

        if (response.ok) {
            console.log('[TRON] Fallback exitoso - cuenta accesible');
        }
        
    } catch (fallbackError) {
        console.error('[TRON] Fallback también falló:', fallbackError.message);
    }
}

/**
 * Busca y procesa pagos pendientes en la red de BSC.
 */
async function checkBscPayments() {
    console.log('[BSC] Iniciando ciclo de chequeo...');

    if (!ETHERSCAN_API_KEY) {
        console.error('[BSC] Error: ETHERSCAN_API_KEY no está disponible. Saltando chequeo de BSC.');
        return;
    }

    try {
        const { data: pendingOrders, error } = await supabase.from('payment_orders').select('user_id, amount').eq('status', 'pending');
        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[BSC] No se encontraron órdenes pendientes.');
            return;
        }
        console.log(`[BSC] Encontradas ${pendingOrders.length} órdenes pendientes.`);
        
        const apiUrl = `https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=${BSC_TREASURY_ADDRESS}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
        
        const response = await fetch(apiUrl, { timeout: 10000 });
        if (!response.ok) throw new Error(`Error de API BscScan: ${response.statusText}`);
        const data = await response.json();

        if (data.status === "1" && data.result.length > 0) {
            console.log(`[BSC] Encontradas ${data.result.length} transacciones de tokens.`);
            
            for (const tx of data.result) {
                const amount_paid = parseFloat(ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal)));
                console.log(`[BSC] Transacción encontrada: ${amount_paid} ${tx.tokenSymbol}`);
                
                const matchingOrder = pendingOrders.find(order => Math.abs(order.amount - amount_paid) < 0.01);
                if (matchingOrder) {
                    console.log(`[BSC] ¡Coincidencia encontrada! Monto: ${amount_paid}, Usuario ID: ${matchingOrder.user_id}`);
                    await activateUser(matchingOrder.user_id, tx.hash);
                }
            }
        } else {
            console.log('[BSC] No se encontraron transacciones de tokens recientes.');
        }
    } catch (error) {
        console.error('[BSC] Error en el listener:', error.message);
    }
}

/**
 * Función centralizada para activar un usuario y actualizar su orden.
 */
async function activateUser(userId, transactionHash) {
    console.log(`🔄 Intentando activar usuario ${userId}...`);
    try {
        // Primero verificar si el usuario ya está activo
        const { data: existingUser, error: checkError } = await supabase
            .from('users')
            .select('status')
            .eq('id', userId)
            .single();
            
        if (checkError) throw checkError;
        
        if (existingUser.status === 'activo') {
            console.log(`⚠️ El usuario ${userId} ya está activo. Evitando duplicación.`);
            return;
        }

        // Actualizar usuario
        const { error: updateUserError } = await supabase
            .from('users')
            .update({ status: 'activo', updated_at: new Date().toISOString() })
            .eq('id', userId);
            
        if (updateUserError) throw updateUserError;

        // Actualizar orden de pago
        const { error: updateOrderError } = await supabase
            .from('payment_orders')
            .update({ 
                status: 'completed', 
                transaction_hash: transactionHash,
                completed_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('status', 'pending'); // Solo actualizar si sigue pendiente
            
        if (updateOrderError) throw updateOrderError;

        console.log(`✅ Usuario ${userId} activado exitosamente. Hash: ${transactionHash}`);
        
    } catch (error) {
        console.error(`❌ Error crítico al activar usuario ${userId}:`, error.message);
    }
}

/**
 * Función para iniciar el listener y hacer que se ejecute periódicamente.
 */
function startListener() {
    const checkInterval = 30000; // 30 segundos para reducir carga
    console.log(`🚀 Iniciando listeners. Se ejecutarán cada ${checkInterval / 1000} segundos.`);
    
    const runChecks = async () => {
        console.log("\n--- 🔍 Nuevo ciclo de búsqueda de pagos ---");
        const startTime = Date.now();
        
        try {
            // Ejecutar verificaciones en paralelo
            await Promise.allSettled([
                checkTronPayments(),
                checkBscPayments()
            ]);
            
            const duration = Date.now() - startTime;
            console.log(`✅ Ciclo completado en ${duration}ms`);
            
        } catch (error) {
            console.error("❌ Error crítico durante la ejecución de los listeners:", error.message);
        }
    };

    try {
        // Ejecutar primer chequeo después de 5 segundos
        setTimeout(runChecks, 5000);
        
        // Programar ejecuciones periódicas
        setInterval(runChecks, checkInterval);
        
        console.log(`✅ Listeners configurados correctamente.`);
        
    } catch (initialRunError) {
        console.error("💥 Error fatal durante el arranque del listener:", initialRunError);
    }
}

module.exports = { startListener };
