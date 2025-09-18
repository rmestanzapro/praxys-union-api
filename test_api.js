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
                }
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
                console.log(`❌ Error: ${errorText}`);
            }
            
        } catch (error) {
            console.log(`💥 Exception: ${error.message}`);
        }
        
        console.log(''); // Línea en blanco
    }
}

// También probar conectividad básica
async function testConnectivity() {
    console.log('🌐 Testing basic connectivity...');
    
    try {
        const response = await fetch('https://api.nile.trongrid.io/wallet/getnowblock');
        if (response.ok) {
            const data = await response.json();
            console.log(`✅ TronGrid conectado - Bloque actual: ${data.block_header?.raw_data?.number}`);
        }
    } catch (error) {
        console.log(`❌ Error de conectividad: ${error.message}`);
    }
}

async function main() {
    console.log('🚀 INICIANDO PRUEBAS DE API TRON\n');
    
    await testConnectivity();
    console.log('');
    await testTronAPIs();
    
    console.log('🏁 PRUEBAS COMPLETADAS');
}

main().catch(console.error);