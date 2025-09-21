require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { startListener } = require('./listener.js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const jwtSecret = process.env.JWT_SECRET;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración
const CONFIG = {
    TESTING_MODE: process.env.TESTING_MODE === "true",
    BASE_AMOUNT: process.env.TESTING_MODE === "true" ? 1 : 15, // 1 USDT base en testing
    DEFAULT_NETWORK: 'tron',
    DEFAULT_EXPIRATION_MINUTES: 15,
};

// Direcciones de treasury desde .env
const TRON_ADDRESS = process.env.TRON_TREASURY_ADDRESS;
const BSC_ADDRESS = process.env.BSC_TREASURY_ADDRESS;

// Validadores de direcciones
const isValidTronAddress = (address) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
const isValidBscAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);

// Middleware
app.use(cors());
app.use(express.json());

// Middleware de autenticación
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.status(401).json({ error: 'Token requerido.' });

    jwt.verify(token, jwtSecret, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token no es válido o ha expirado.' });
        req.user = user;
        next();
    });
}

// Endpoint para info del referente
app.get('/api/referrer-info', async (req, res) => {
    const { ref_code } = req.query;
    if (!ref_code) {
        return res.status(400).json({ error: 'Código de referente es requerido.' });
    }
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('first_name')
            .eq('referral_code', ref_code)
            .single();
        if (error || !user) {
            return res.status(404).json({ error: 'Referente no encontrado.' });
        }
        res.status(200).json({ display_name: user.first_name });
    } catch (error) {
        console.error('Error en referrer-info:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoint de registro
app.post('/register', async (req, res) => {
    const { email, password, username, first_name, last_name, country, referral_code } = req.body;
    if (!email || !password || !username || !referral_code || !first_name || !last_name || !country) {
        return res.status(400).json({ error: 'Todos los campos son requeridos.' });
    }
    try {
        const { data: existingUser } = await supabase.from('users').select('email, username').or(`email.eq.${email},username.eq.${username}`).single();
        if (existingUser) { return res.status(400).json({ error: 'El email o username ya está en uso.' }); }

        const { data: parentUser, error: findParentError } = await supabase
            .from('users')
            .select('id')
            .eq('referral_code', referral_code)
            .single();
        if (findParentError || !parentUser) {
            return res.status(404).json({ error: 'Código de referido inválido.' });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const newUserReferralCode = `${username.toUpperCase()}${Math.random().toString(36).substring(2, 8)}`;

        const { data: newUser, error: newUserError } = await supabase
            .from('users')
            .insert({ email, username, password_hash, referral_code: newUserReferralCode, referred_by_id: parentUser.id, first_name, last_name, country, contribution: CONFIG.BASE_AMOUNT, group_name: 'Starter' })
            .select()
            .single();
        if (newUserError) { throw newUserError; }

        // Crear orden con monto único: base + random (igual en testing y producción)
        const uniqueAmount = CONFIG.BASE_AMOUNT + parseFloat((Math.random() * 0.01).toFixed(6));
        if (uniqueAmount <= 0) throw new Error('Monto inválido.');

        console.log(`[REGISTER] Creando orden con monto único: ${uniqueAmount} USDT ${CONFIG.TESTING_MODE ? '(Testing)' : '(Producción)'}`);

        const { data: newOrder, error: orderError } = await supabase
            .from('payment_orders')
            .insert({ 
                user_id: newUser.id, 
                amount: uniqueAmount, 
                status: 'pending'
            })
            .select('id')
            .single();

        if (orderError) { throw orderError; }

        res.status(201).json({ 
            message: 'Usuario creado exitosamente', 
            user: newUser, 
            orderId: newOrder.id
        });
    } catch (error) {
        console.error('Error en register:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoint de login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) { return res.status(400).json({ error: 'Email y password son requeridos.' }); }
    try {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if (!user) { return res.status(401).json({ error: 'Credenciales inválidas.' }); }

        const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordCorrect) { return res.status(401).json({ error: 'Credenciales inválidas.' }); }

        const token = jwt.sign({ userId: user.id, email: user.email }, jwtSecret, { expiresIn: '24h' });
        res.status(200).json({ message: 'Login exitoso', token: token });
    } catch (error) {
        console.error('Error en login:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoint para detalles del checkout
app.get('/api/checkout-details/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const { data: order, error } = await supabase
            .from('payment_orders')
            .select('amount, created_at')
            .eq('id', orderId)
            .single();
        if (error || !order) {
            return res.status(404).json({ error: 'Orden no encontrada.' });
        }

        // Usar monto único de la DB (ya incluye random)
        const uniqueAmount = Number(order.amount);
        if (uniqueAmount <= 0) throw new Error('Monto inválido.');

        // Red por default
        const network = CONFIG.DEFAULT_NETWORK;
        const address = network === 'tron' ? TRON_ADDRESS : BSC_ADDRESS;
        const explorerBase = network === 'tron' ? 'https://tronscan.org/#/transaction/' : 'https://bscscan.com/tx/';

        // Validar dirección
        if (network === 'tron' && !isValidTronAddress(address)) {
            throw new Error('Dirección TRON inválida.');
        } else if (network === 'bsc' && !isValidBscAddress(address)) {
            throw new Error('Dirección BSC inválida.');
        }

        // Expiración (15 min después de created_at)
        const createdAt = new Date(order.created_at);
        const expiresAt = new Date(createdAt.getTime() + CONFIG.DEFAULT_EXPIRATION_MINUTES * 60 * 1000).toISOString();

        console.log(`[CHECKOUT-DETAILS] Orden ${orderId}: ${uniqueAmount.toFixed(6)} USDT ${CONFIG.TESTING_MODE ? '(Testing)' : '(Producción)'}`);

        res.status(200).json({
            uniqueAmount: uniqueAmount.toFixed(6),
            network,
            address,
            explorerBase,
            expiresAt,
            symbol: 'USDT',
            color: network === 'tron' ? 'text-red-500' : 'text-yellow-500',
            badgeClass: network === 'tron' ? 'bg-red-500/15 border border-red-500/40' : 'bg-yellow-500/15 border border-yellow-500/40',
        });
    } catch (error) {
        console.error('Error en checkout-details:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// NUEVO: Endpoint para estado del pago (para frontend polling)
app.get('/api/payment-status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const { data: order, error } = await supabase
            .from('payment_orders')
            .select('status, transaction_hash, completed_at, network')
            .eq('id', orderId)
            .single();
        if (error || !order) {
            return res.status(404).json({ error: 'Orden no encontrada.' });
        }

        const status = order.status === 'completed' ? 'completed' : (order.status === 'failed' ? 'failed' : 'pending');
        res.status(200).json({
            status,
            txHash: order.transaction_hash || null,
        });
    } catch (error) {
        console.error('Error en payment-status:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoints protegidos
app.get('/me/tree', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const { data, error } = await supabase.rpc('get_user_tree', { p_user_id: userId });
        if (error) { throw error; }
        res.status(200).json({ message: 'Árbol del usuario obtenido con éxito', tree: data });
    } catch (error) {
        console.error('Error en me/tree:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Rutas de prueba
app.get('/test-db', async (req, res) => {
    const { data, error } = await supabase.from('users').select('*');
    if (error) { res.status(500).json({ error: error.message }); }
    else { res.json({ message: "Conexión a la base de datos exitosa!", data: data }); }
});

app.get('/', (req, res) => {
    res.json({ message: "Welcome to the Praxys Union API! Ready for production." });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startListener();
});
