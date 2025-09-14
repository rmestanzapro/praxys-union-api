// =================================================================
// --- 1. IMPORTACIONES Y CONFIGURACIÓN ---
// =================================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const jwtSecret = process.env.JWT_SECRET;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const PORT = process.env.PORT || 3000;

// =================================================================
// --- 2. MIDDLEWARES ---
// =================================================================
app.use(cors());
app.use(express.json());

// =================================================================
// --- 3. MIDDLEWARE DE AUTENTICACIÓN (EL "GUARDIAN") ---
// =================================================================
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

// =================================================================
// --- 4. ENDPOINTS PÚBLICOS ---
// =================================================================

// --- NUEVO --- ENDPOINT PARA OBTENER INFO DEL REFERENTE
app.get('/api/referrer-info', async (req, res) => {
    // El frontend lo llama para mostrar el nombre real en el funnel
    const { username } = req.query; 

    if (!username) {
        return res.status(400).json({ error: 'Username del referente es requerido.' });
    }

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('first_name') // Solo necesitamos el nombre de pila
            .eq('username', username) // Buscamos por username
            .single();

        if (error || !user) {
            return res.status(404).json({ error: 'Referente no encontrado.' });
        }

        // Si lo encuentra, responde con el formato que el frontend espera
        res.status(200).json({ display_name: user.first_name });

    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
    }
});


// --- MODIFICADO --- ENDPOINT DE REGISTRO DE USUARIOS
app.post('/register', async (req, res) => {
    // --- MODIFICADO --- Aceptamos los nuevos campos del formulario
    const { email, password, username, first_name, last_name, country, referral_code } = req.body;

    // --- MODIFICADO --- Validamos los nuevos campos
    if (!email || !password || !username || !referral_code || !first_name || !last_name || !country) {
        return res.status(400).json({ error: 'Todos los campos, incluido el código de referido, son requeridos.' });
    }

    try {
        const { data: existingUser } = await supabase.from('users').select('email, username').or(`email.eq.${email},username.eq.${username}`).single();
        if (existingUser) { return res.status(400).json({ error: 'El email o username ya está en uso.' }); }

        // Nota: La validación del referente aquí se hace por 'referral_code'. Asegúrate que esto sea consistente
        // con cómo generas los links. La ruta /referrer-info que añadimos busca por 'username'.
        const { data: parentUser, error: findParentError } = await supabase
            .from('users')
            .select('id')
            .eq('referral_code', referral_code)
            .single();

        if (findParentError || !parentUser) {
            return res.status(404).json({ error: 'El código de referido proporcionado no es válido o no existe.' });
        }
        const parentId = parentUser.id;

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const newUserReferralCode = `${username.toUpperCase()}${Math.random().toString(36).substring(2, 8)}`;

        // --- MODIFICADO --- Insertamos los nuevos campos en la base de datos
        const { data: newUser, error: newUserError } = await supabase
            .from('users')
            .insert({ 
                email, 
                username, 
                password_hash, 
                referral_code: newUserReferralCode, 
                referred_by_id: parentId,
                first_name,
                last_name,
                country,
                // Valores por defecto que venían de tu frontend
                contribution: 15, 
                group_name: 'Starter' 
            })
            .select()
            .single();

        if (newUserError) { throw newUserError; }
        
        // --- NUEVO --- Lógica para crear la orden de pago
        const uniqueAmount = 15.00 + parseFloat((Math.random() * 0.01).toFixed(6));
        const { data: newOrder, error: orderError } = await supabase
            .from('payment_orders') // Requiere una tabla 'payment_orders'
            .insert({
                user_id: newUser.id,
                amount: uniqueAmount,
                status: 'pending'
            })
            .select('id')
            .single();

        if (orderError) { throw orderError; }
        
        // --- MODIFICADO --- La respuesta ahora incluye el orderId
        res.status(201).json({ 
            message: 'Usuario creado exitosamente', 
            user: newUser,
            orderId: newOrder.id 
        });

    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
    }
});


// --- ENDPOINT DE LOGIN DE USUARIOS ---
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) { return res.status(400).json({ error: 'Email y password son requeridos.' }); }

    try {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if (!user) { return res.status(401).json({ error: 'Credenciales inválidas.' }); }

        const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordCorrect) { return res.status(401).json({ error: 'Credenciales inválidas.' }); }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            jwtSecret,
            { expiresIn: '24h' }
        );
        res.status(200).json({ message: 'Login exitoso', token: token });

    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
    }
});


// --- NUEVO --- ENDPOINT PARA DETALLES DEL CHECKOUT
app.get('/api/checkout-details/:orderId', async (req, res) => {
    const { orderId } = req.params;

    try {
        const { data: order, error } = await supabase
            .from('payment_orders') // Requiere una tabla 'payment_orders'
            .select('amount')
            .eq('id', orderId)
            .single();

        if (error || !order) {
            return res.status(404).json({ error: 'Orden de pago no encontrada.' });
        }

        res.status(200).json({ uniqueAmount: order.amount.toFixed(6) });

    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
    }
});


// =================================================================
// --- 5. ENDPOINTS PROTEGIDOS ---
// =================================================================
app.get('/me/tree', authenticateToken, async (req, res) => {
    // ... (tu código existente)
});

// =================================================================
// --- 6. RUTAS DE PRUEBA ---
// =================================================================
app.get('/test-db', async (req, res) => {
    // ... (tu código existente)
});

app.get('/', (req, res) => {
    // ... (tu código existente)
});

// =================================================================
// --- 7. INICIAR SERVIDOR ---
// =================================================================
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

