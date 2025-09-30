// test_api.js - Script para probar las APIs manualmente
require('dotenv').config();

const TRON_TREASURY_ADDRESS = 'TB3idCQ8aojaeMx9kdudp6vgN3TWJFdrTW';
const TRON_USDT_CONTRACT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkM3Uo';

async function testTronAPIs() {
    console.log('🧪 TESTING TRON APIs...\n');

    const apis = [
        {
            name: 'TronScan Official',
            url: `https://nileapi.tronscan.org/api/token_trc20/transfers?limit=10&relatedAddress=${TRON_TREASURY_ADDRESS}&filterTokenValue=0`
        },
        {
            name: 'TronGrid Direct', 
            url: `https://api.nile.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions?limit=10`
        }
    ];

    for (const api of apis) {
        console.log(`🔄 Probando ${api.name}...`);
        console.log(`🌐 URL: ${api.url}`);
        
        try {
            const response = await fetch(api.url, {
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.TRONGRID_API_KEY && { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY })
                },
                signal: AbortSignal.timeout(10000) // 10 second timeout
            });

            console.log(`📡 Status: ${response.status} ${response.statusText}`);
            
            if (response.ok) {
                const data = await response.json();
                console.log('✅ Respuesta exitosa!');
                console.log('📦 Estructura de datos:');
                
                if (api.name.includes('TronScan')) {
                    console.log(`   - token_transfers: ${data.token_transfers ? data.token_transfers.length : 0} items`);
                    if (data.token_transfers && data.token_transfers.length > 0) {
                        console.log('   🔍 Primera transacción:');
                        const first = data.token_transfers[0];
                        console.log(`     - Contrato: ${first.contractAddress}`);
                        console.log(`     - Para: ${first.to_address}`);
                        console.log(`     - Cantidad: ${first.quant}`);
                        console.log(`     - Símbolo: ${first.tokenInfo?.tokenSymbol}`);
                    }
                } else {
                    console.log(`   - data: ${data.data ? data.data.length : 0} items`);
                    if (data.data && data.data.length > 0) {
                        console.log('   🔍 Primera transacción tiene logs:', !!data.data[0].log);
                    }
                }
                
            } else {
                const errorText = await response.text();
                console.log(`❌ Error HTTP ${response.status}: ${errorText}`);
            }
            
        } catch (error) {
            if (error.name === 'TimeoutError') {
                console.log(`⏰ Timeout: ${api.name} no respondió en 10 segundos`);
            } else if (error.message.includes('fetch failed')) {
                console.log(`🔒 Acceso restringido: No se puede acceder a ${api.name} en este entorno`);
                console.log(`ℹ️  Esto es esperado en entornos sandboxed o con restricciones de red`);
            } else {
                console.log(`💥 Exception: ${error.message}`);
            }
        }
        
        console.log(''); // Línea en blanco
    }
}

// También probar conectividad básica
async function testConnectivity() {
    console.log('🌐 Testing basic connectivity...');
    
    try {
        const response = await fetch('https://api.nile.trongrid.io/wallet/getnowblock', {
            signal: AbortSignal.timeout(5000) // 5 second timeout
        });
        if (response.ok) {
            const data = await response.json();
            console.log(`✅ TronGrid conectado - Bloque actual: ${data.block_header?.raw_data?.number}`);
            return true;
        } else {
            console.log(`⚠️ TronGrid respondió con status ${response.status}`);
            return false;
        }
    } catch (error) {
        if (error.name === 'TimeoutError') {
            console.log(`⏰ Timeout de conectividad: Las APIs externas pueden no estar disponibles en este entorno`);
        } else if (error.message.includes('fetch failed')) {
            console.log(`🔒 Acceso a red restringido: Este entorno puede tener limitaciones de conectividad externa`);
            console.log(`ℹ️  Esto es normal en entornos de desarrollo/testing sandboxed`);
        } else {
            console.log(`❌ Error de conectividad: ${error.message}`);
        }
        return false;
    }
}

async function main() {
    console.log('🚀 INICIANDO PRUEBAS DE API TRON\n');
    
    const isConnected = await testConnectivity();
    console.log('');
    
    if (!isConnected) {
        console.log('⚠️  AVISO: Sin conectividad externa detectada');
        console.log('📝 Las pruebas de API mostrarán errores de conectividad esperados\n');
    }
    
    await testTronAPIs();
    
    console.log('🏁 PRUEBAS COMPLETADAS');
    
    if (!isConnected) {
        console.log('\n💡 NOTA: Los errores de conectividad son normales en entornos sandboxed');
        console.log('🔧 En producción, asegúrate de que las APIs externas sean accesibles');
    }
}

main().catch(console.error);