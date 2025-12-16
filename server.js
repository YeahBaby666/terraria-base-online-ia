const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURACIÓN ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'TU_URL_AQUI';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'TU_KEY_AQUI';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- MEMORIA DE ESTADO (Solo para nuevos usuarios) ---
const roomStates = {}; 

io.on('connection', (socket) => {
    
    // 1. UNIRSE
    socket.on('join_room', async (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;

        // Recuperar estado previo si no está en RAM
        if (!roomStates[roomId]) {
            roomStates[roomId] = { players: {}, global: {} };
            const { data } = await supabase.from('room_storage').select('public_state').eq('room_id', roomId).single();
            if (data?.public_state) {
                roomStates[roomId] = { ...roomStates[roomId], ...data.public_state };
            }
        }

        // Enviar estado actual SOLO al que entra
        socket.emit('init_state', roomStates[roomId]);
    });

    // 2. DATA RELAY (Tubería principal)
    socket.on('data', (packet) => {
        const roomId = socket.currentRoom;
        if (!roomId) return;

        const { action, targetId, ...payload } = packet;

        // A. ACCIONES DE SISTEMA
        if (action === 'SYS_SAVE') {
            handleSave(roomId, payload, socket);
            return;
        }

        // B. ACTUALIZAR MEMORIA DEL SERVIDOR (Fusión simple)
        // Para que si entra alguien nuevo, vea lo último.
        // Nota: No ejecutamos lógica, solo guardamos el dato crudo bajo el ID.
        if (roomStates[roomId] && roomStates[roomId].players) {
            if (!roomStates[roomId].players[socket.id]) {
                roomStates[roomId].players[socket.id] = {};
            }
            // Mezclar datos nuevos con los existentes
            Object.assign(roomStates[roomId].players[socket.id], payload);
        }

        // C. BROADCAST A TODOS (Incluido remitente)
        // El SDK del cliente se encargará de filtrar si es privado.
        io.to(roomId).emit('relay_event', {
            senderId: socket.id,
            action: action || 'UPDATE',
            targetId: targetId || null, // Si lleva destino, lo pasamos
            ...payload
        });
    });

    // 3. DESCONEXIÓN
    socket.on('disconnect', () => {
        const roomId = socket.currentRoom;
        if (roomId && roomStates[roomId]?.players[socket.id]) {
            delete roomStates[roomId].players[socket.id];
            io.to(roomId).emit('relay_event', { senderId: socket.id, action: 'DISCONNECT' });
        }
    });
});

async function handleSave(roomId, payload, socket) {
    const { type, content, extra } = payload;
    if (type === 'html') {
        const update = { client_html: content };
        if(extra?.creator) update.creator_name = extra.creator;
        await supabase.from('game_rooms').update(update).eq('id', roomId);
    } else if (type === 'state') {
        // Guardamos lo que tenemos en memoria RAM actualmente
        const stateToSave = roomStates[roomId] || content;
        await supabase.from('room_storage').upsert({ room_id: roomId, public_state: stateToSave, updated_at: new Date() });
    }
    socket.emit('notification', 'Guardado en Nube OK');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Relay Puro corriendo en ${PORT}`));