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

// --- CORREGIDO --- ENDPOINT PARA OBTENER INFO DEL REFERENTE (USA REFERRAL_CODE)
app.get('/api/referrer-info', async (req, res) => {
    // Leemos el parámetro 'ref' del link, que ahora contendrá el referral_code
    const { ref_code } = req.query; 

    if (!ref_code) {
        return res.status(400).json({ error: 'Código de referente es requerido.' });
    }

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('first_name')
            .eq('referral_code', ref_code) // <-- CORRECCIÓN: Busca por referral_code
            .single();

        if (error || !user) {
            return res.status(404).json({ error: 'Referente no encontrado.' });
        }

        res.status(200).json({ display_name: user.first_name });

    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
    }
});

// --- ENDPOINT DE REGISTRO DE USUARIOS (VALIDA CON REFERRAL_CODE) ---
app.post('/register', async (req, res) => {
    const { email, password, username, first_name, last_name, country, referral_code } = req.body;

    if (!email || !password || !username || !referral_code || !first_name || !last_name || !country) {
        return res.status(400).json({ error: 'Todos los campos, incluido el código de referido, son requeridos.' });
    }

    try {
        const { data: existingUser } = await supabase.from('users').select('email, username').or(`email.eq.${email},username.eq.${username}`).single();
        if (existingUser) { return res.status(400).json({ error: 'El email o username ya está en uso.' }); }

        // Esta parte ya era correcta, valida con referral_code
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
                contribution: 15,
                group_name: 'Starter'
            })
            .select()
            .single();

        if (newUserError) { throw newUserError; }

        const uniqueAmount = 15.00 + parseFloat((Math.random() * 0.01).toFixed(6));
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

// --- ENDPOINT PARA DETALLES DEL CHECKOUT ---
app.get('/api/checkout-details/:orderId', async (req, res) => {
    const { orderId } = req.params;

    try {
        const { data: order, error } = await supabase
            .from('payment_orders')
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
    const userId = req.user.userId;
    try {
        const { data, error } = await supabase.rpc('get_user_tree', {
            p_user_id: userId
        });

        if (error) { throw error; }
        res.status(200).json({ message: 'Árbol del usuario obtenido con éxito', tree: data });

    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
    }
});

// =================================================================
// --- 6. RUTAS DE PRUEBA ---
// =================================================================
app.get('/test-db', async (req, res) => {
    const { data, error } = await supabase.from('users').select('*');
    if (error) { res.status(500).json({ error: error.message }); }
    else { res.json({ message: "Conexión a la base de datos exitosa!", data: data }); }
});

app.get('/', (req, res) => {
    res.json({ message: "Welcome to the Praxys Union API! Ready for production." });
});

// =================================================================
// --- 7. INICIAR SERVIDOR ---
// =================================================================
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

