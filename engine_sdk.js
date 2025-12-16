/**
 * EngineIO SDK
 * Cliente oficial para conectar con servidores EngineIO.
 * * Uso:
 * 1. EngineSDK.init({ serverUrl: 'https://mi-servidor.render.com' });
 * 2. EngineSDK.conectar('nombre-sala', (id) => console.log('Conectado', id));
 */
(function(global) {
    
    const EngineSDK = {
        config: {
            serverUrl: 'http://localhost:3000', // Valor por defecto para desarrollo local
            debug: false
        },
        
        socket: null,
        currentRoom: null,
        lastStateReceived: {},

        /**
         * Configura el SDK antes de usarlo.
         * @param {Object} options - { serverUrl: string, debug: boolean }
         */
        init: function(options) {
            if (options.serverUrl) this.config.serverUrl = options.serverUrl;
            if (options.debug) this.config.debug = options.debug;
            this.log(`SDK Inicializado apuntando a: ${this.config.serverUrl}`);
        },

        log: function(msg) {
            if (this.config.debug) console.log(`[EngineSDK] ${msg}`);
        },

        // --- CONEXIÓN ---
        conectar: function(roomId, onConnect, onDisconnect) {
            if (typeof io === 'undefined') {
                console.error("[EngineSDK] Error Crítico: Socket.IO no está cargado. Añade <script src='https://cdn.socket.io/4.7.2/socket.io.min.js'></script>");
                return;
            }
            
            // Evitar reconexión si ya está conectado a la misma sala
            if (this.socket && this.socket.connected && this.currentRoom === roomId) {
                this.log("Ya conectado a esta sala.");
                if (onConnect) onConnect(this.socket.id);
                return;
            }

            if (this.socket) this.socket.disconnect();

            this.log(`Conectando a ${this.config.serverUrl}...`);
            this.socket = io(this.config.serverUrl);
            this.currentRoom = roomId;

            this.socket.on('connect', () => {
                this.log(`Conexión exitosa. ID: ${this.socket.id}`);
                this.socket.emit('join_room', roomId);
                if (onConnect) onConnect(this.socket.id);
            });

            this.socket.on('disconnect', () => {
                this.log("Desconectado.");
                if (onDisconnect) onDisconnect();
            });

            this.socket.on('connect_error', (err) => {
                console.error("[EngineSDK] Error de conexión:", err.message);
            });
            
            // Listeners internos
            this._setupInternalListeners();
        },

        _setupInternalListeners: function() {
            this.socket.on('game_tick', (state) => {
                this.lastStateReceived = state;
            });
        },

        // --- API DE JUEGO ---
        alRecibirEstado: function(callback) {
            if (!this.socket) return;
            this.socket.on('game_tick', callback);
        },

        enviarInput: function(roomId, type, data) {
            if (!this.socket) return;
            this.socket.emit('input_data', { 
                roomId: roomId, 
                payload: { type: type, ...data } 
            });
        },

        // --- HERRAMIENTAS DE INTROSPECCIÓN ---
        obtenerEsquema: function() {
            const keys = Object.keys(this.lastStateReceived);
            const schema = {};
            keys.forEach(k => {
                const val = this.lastStateReceived[k];
                let type = typeof val;
                if (Array.isArray(val)) type = 'Array';
                let preview = (type === 'object' && val !== null) ? '{...}' : String(val).substring(0, 30);
                schema[k] = { type, preview };
            });
            return schema;
        },

        // --- PERSISTENCIA (SUPABASE VIA SOCKET) ---
        guardar: function(type, content, extra = {}) {
            if (!this.socket || !this.currentRoom) return;
            this.socket.emit('persist_save', {
                roomId: this.currentRoom, 
                type: type, 
                content: content,
                extra: extra 
            });
        },

        cargar: function(type, callback) {
            if (!this.socket || !this.currentRoom) return;
            this.socket.emit('persist_load', { roomId: this.currentRoom, type });
            this.socket.once('persist_loaded', (res) => {
                if (res.type === type) callback(res.content);
            });
        },
        
        // --- UTILIDADES ---
        desconectar: function() {
            if (this.socket) this.socket.disconnect();
            this.socket = null;
            this.currentRoom = null;
        }
    };

    // Exponer globalmente
    global.EngineSDK = EngineSDK;

})(window);