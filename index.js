require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { startListener } = require('./listener.js');
const logger = require('./logger');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const jwtSecret = process.env.JWT_SECRET;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración
const CONFIG = {
    TESTING_MODE: process.env.TESTING_MODE === "true",
    BASE_AMOUNT: process.env.TESTING_MODE === "true" ? 1 : 15,
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
    if (token == null) {
        logger.warn('Intento de acceso sin token', { path: req.path });
        return res.status(401).json({ error: 'Token requerido.' });
    }

    jwt.verify(token, jwtSecret, (err, user) => {
        if (err) {
            logger.warn('Token inválido o expirado', { path: req.path });
            return res.status(403).json({ error: 'Token no es válido o ha expirado.' });
        }
        req.user = user;
        next();
    });
}

// Endpoint para info del referente
app.get('/api/referrer-info', async (req, res) => {
    const { ref_code } = req.query;
    if (!ref_code) {
        logger.warn('Código de referente no proporcionado', { query: req.query });
        return res.status(400).json({ error: 'Código de referente es requerido.' });
    }
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('first_name')
            .eq('referral_code', ref_code)
            .single();
        if (error || !user) {
            logger.warn('Referente no encontrado', { ref_code });
            return res.status(404).json({ error: 'Referente no encontrado.' });
        }
        logger.info('Información de referente obtenida', { ref_code, first_name: user.first_name });
        res.status(200).json({ display_name: user.first_name });
    } catch (error) {
        logger.error('Error en referrer-info', { error: error.message });
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoint de registro
app.post('/register', async (req, res) => {
    const { email, password, username, first_name, last_name, country, referral_code } = req.body;
    if (!email || !password || !username || !referral_code || !first_name || !last_name || !country) {
        logger.warn('Campos incompletos en registro', { body: req.body });
        return res.status(400).json({ error: 'Todos los campos son requeridos.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const newUserReferralCode = `${username.toUpperCase()}${Math.random().toString(36).substring(2, 8)}`;

        logger.info('Iniciando registro para usuario', { email, username });

        // Llamada a la función RPC de Supabase para la transacción
        const { data, error } = await supabase.rpc('create_user_and_order', {
            p_email: email,
            p_username: username,
            p_password_hash: password_hash,
            p_first_name: first_name,
            p_last_name: last_name,
            p_country: country,
            p_referral_code: newUserReferralCode,
            p_parent_ref_code: referral_code,
            p_base_amount: CONFIG.BASE_AMOUNT
        });

        if (error) {
            if (error.message.includes('parent_not_found')) {
                logger.warn('Código de referido inválido', { referral_code });
                return res.status(404).json({ error: 'Código de referido inválido.' });
            }
            if (error.message.includes('user_exists')) {
                logger.warn('Usuario ya existe', { email, username });
                return res.status(400).json({ error: 'El email o username ya está en uso.' });
            }
            throw error;
        }

        logger.info('Usuario y orden creados exitosamente', { userId: data.user_id, orderId: data.order_id });
        
        res.status(201).json({ 
            message: 'Usuario creado exitosamente', 
            userId: data.user_id,
            orderId: data.order_id 
        });

    } catch (error) {
        logger.error('Error en el endpoint de registro', { error: error.message });
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoint de login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        logger.warn('Campos incompletos en login', { body: req.body });
        return res.status(400).json({ error: 'Email y password son requeridos.' });
    }
    try {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if (!user) {
            logger.warn('Usuario no encontrado en login', { email });
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordCorrect) {
            logger.warn('Contraseña incorrecta', { email });
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const token = jwt.sign({ userId: user.id, email: user.email }, jwtSecret, { expiresIn: '24h' });
        logger.info('Login exitoso', { userId: user.id, email });
        res.status(200).json({ message: 'Login exitoso', token: token });
    } catch (error) {
        logger.error('Error en login', { error: error.message });
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
            logger.warn('Orden no encontrada en checkout-details', { orderId });
            return res.status(404).json({ error: 'Orden no encontrada.' });
        }

        const uniqueAmount = Number(order.amount);
        if (uniqueAmount <= 0) {
            logger.error('Monto inválido en checkout-details', { orderId, amount: uniqueAmount });
            throw new Error('Monto inválido.');
        }

        const network = CONFIG.DEFAULT_NETWORK;
        const address = network === 'tron' ? TRON_ADDRESS : BSC_ADDRESS;
        const explorerBase = network === 'tron' ? 'https://tronscan.org/#/transaction/' : 'https://bscscan.com/tx/';

        if (network === 'tron' && !isValidTronAddress(address)) {
            logger.error('Dirección TRON inválida', { address });
            throw new Error('Dirección TRON inválida.');
        } else if (network === 'bsc' && !isValidBscAddress(address)) {
            logger.error('Dirección BSC inválida', { address });
            throw new Error('Dirección BSC inválida.');
        }

        const createdAt = new Date(order.created_at);
        const expiresAt = new Date(createdAt.getTime() + CONFIG.DEFAULT_EXPIRATION_MINUTES * 60 * 1000).toISOString();

        logger.info(`[CHECKOUT-DETAILS] Orden ${orderId}: ${uniqueAmount.toFixed(6)} USDT ${CONFIG.TESTING_MODE ? '(Testing)' : '(Producción)'}`);

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
        logger.error('Error en checkout-details', { orderId, error: error.message });
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoint para estado del pago
app.get('/api/payment-status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const { data: order, error } = await supabase
            .from('payment_orders')
            .select('status, transaction_hash, completed_at, network')
            .eq('id', orderId)
            .single();
        if (error || !order) {
            logger.warn('Orden no encontrada en payment-status', { orderId });
            return res.status(404).json({ error: 'Orden no encontrada.' });
        }

        const status = order.status === 'completed' ? 'completed' : (order.status === 'failed' || order.status === 'expired' ? order.status : 'pending');
        logger.info(`[PAYMENT-STATUS] Orden ${orderId}: ${status}`, { transaction_hash: order.transaction_hash });
        res.status(200).json({
            status,
            txHash: order.transaction_hash || null,
        });
    } catch (error) {
        logger.error('Error en payment-status', { orderId, error: error.message });
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Endpoints protegidos
app.get('/me/tree', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const { data, error } = await supabase.rpc('get_user_tree', { p_user_id: userId });
        if (error) {
            logger.error('Error en me/tree', { userId, error: error.message });
            throw error;
        }
        logger.info('Árbol del usuario obtenido', { userId });
        res.status(200).json({ message: 'Árbol del usuario obtenido con éxito', tree: data });
    } catch (error) {
        logger.error('Error en me/tree', { userId, error: error.message });
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Rutas de prueba
app.get('/test-db', async (req, res) => {
    try {
        const { data, error } = await supabase.from('users').select('*');
        if (error) {
            logger.error('Error en test-db', { error: error.message });
            return res.status(500).json({ error: error.message });
        }
        logger.info('Conexión a la base de datos exitosa', { userCount: data.length });
        res.json({ message: "Conexión a la base de datos exitosa!", data: data });
    } catch (error) {
        logger.error('Error en test-db', { error: error.message });
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.get('/', (req, res) => {
    logger.info('Acceso a la ruta raíz');
    res.json({ message: "Welcome to the Praxys Union API! Ready for production." });
});

// Iniciar servidor
app.listen(PORT, () => {
    logger.info(`Servidor API iniciado en el puerto ${PORT}`);
    startListener();
});
