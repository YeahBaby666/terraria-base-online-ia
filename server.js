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

const activeRooms = {}; 

io.on('connection', (socket) => {
    
    socket.on('join_room', async (roomId) => {
        if (socket.currentRoom) leaveRoom(socket);
        socket.join(roomId);
        socket.currentRoom = roomId;

        if (!activeRooms[roomId]) activeRooms[roomId] = { users: 0 };
        activeRooms[roomId].users++;

        // Carga inicial opcional (para compatibilidad con lógica anterior)
        const { data } = await supabase.from('room_storage').select('public_state').eq('room_id', roomId).single();
        if (data?.public_state) socket.emit('init_state', data.public_state);
    });

    socket.on('data', (packet) => {
        const roomId = socket.currentRoom;
        if (!roomId) return;

        const { action, ...payload } = packet;

        // --- A. ACCIONES DE BASE DE DATOS (NUEVO) ---
        if (action === 'SYS_DB_GET') {
            handleDbGet(roomId, payload, socket);
            return;
        }
        if (action === 'SYS_DB_SET') {
            handleDbSet(roomId, payload);
            return;
        }

        // --- B. ACCIONES DE SISTEMA LEGACY ---
        if (action === 'SYS_SAVE') {
            handleLegacySave(roomId, payload, socket);
            return;
        }

        // --- C. RELAY (JUEGO) ---
        io.to(roomId).emit('relay_event', { senderId: socket.id, action: action || 'UNKNOWN', ...payload });
    });

    socket.on('disconnect', () => leaveRoom(socket));
});

// --- MANEJADORES DE DB ---

async function handleDbGet(roomId, payload, socket) {
    const { bucket, key, reqId } = payload;
    // Mapeo: 'public' -> public_state, 'private' -> private_data
    const column = bucket === 'public' ? 'public_state' : 'private_data';

    const { data } = await supabase
        .from('room_storage')
        .select(column)
        .eq('room_id', roomId)
        .single();

    let result = null;
    if (data && data[column]) {
        // Si piden una key especifica, devolvemos solo eso. Si no, todo el JSON.
        result = key ? data[column][key] : data[column];
    }

    // Responder solo al que preguntó
    socket.emit('db_response', { reqId, data: result });
}

async function handleDbSet(roomId, payload) {
    const { bucket, key, value } = payload;
    const column = bucket === 'public' ? 'public_state' : 'private_data';

    // 1. Obtener JSON actual para no borrar otras claves
    const { data } = await supabase
        .from('room_storage')
        .select(column)
        .eq('room_id', roomId)
        .single();

    let currentJson = (data && data[column]) ? data[column] : {};

    // 2. Actualizar o Insertar
    if (key) {
        // Actualizar una clave específica (ej: 'users')
        currentJson[key] = value;
    } else if (typeof value === 'object') {
        // Fusionar objeto completo
        currentJson = { ...currentJson, ...value };
    }

    // 3. Guardar en BD
    const updateData = {};
    updateData[column] = currentJson;
    
    await supabase
        .from('room_storage')
        .upsert({ room_id: roomId, ...updateData, updated_at: new Date() });
    
    // Opcional: Notificar a la sala que hubo un cambio en DB (Live update)
    // io.to(roomId).emit('relay_event', { action: 'DB_UPDATE', bucket, key, value });
}

function leaveRoom(socket) {
    const roomId = socket.currentRoom;
    if (roomId && activeRooms[roomId]) {
        activeRooms[roomId].users--;
        io.to(roomId).emit('relay_event', { senderId: socket.id, action: 'DISCONNECT' });
    }
}

async function handleLegacySave(roomId, payload, socket) {
    // ... lógica anterior de guardado html/state ...
    const { type, content, extra } = payload;
    const update = {};
    if (type === 'html') {
        update.client_html = content;
        if(extra?.creator) update.creator_name = extra.creator;
        await supabase.from('game_rooms').update(update).eq('id', roomId);
    } 
    socket.emit('notification', 'Guardado OK');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server v4 (DB API) running on ${PORT}`));