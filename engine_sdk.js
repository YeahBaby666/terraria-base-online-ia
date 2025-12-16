(function(global) {
    const EngineSDK = {
        config: { serverUrl: 'http://localhost:3000', debug: false },
        socket: null,
        currentRoom: null,
        _onEventCallback: null,
        _onNotifyCallback: null,

        init: function(options) {
            if (options.serverUrl) this.config.serverUrl = options.serverUrl;
        },

        conectar: function(roomId, callbacks = {}) {
            if (typeof io === 'undefined') return console.error("Falta Socket.IO");
            if (this.socket) this.socket.disconnect();
            
            this.socket = io(this.config.serverUrl);
            this.currentRoom = roomId;

            this.socket.on('connect', () => {
                this.socket.emit('join_room', roomId);
                if (callbacks.onConnect) callbacks.onConnect(this.socket.id);
            });

            this.socket.on('relay_event', (eventData) => {
                if (this._onEventCallback) this._onEventCallback(eventData);
            });

            this.socket.on('notification', (msg) => {
                if (this._onNotifyCallback) this._onNotifyCallback(msg);
            });

            // RESPUESTA DE BASE DE DATOS
            this.socket.on('db_response', (res) => {
                // Buscamos si hay un callback pendiente para este ID de petición
                if (this._dbCallbacks[res.reqId]) {
                    this._dbCallbacks[res.reqId](res.data);
                    delete this._dbCallbacks[res.reqId]; // Limpieza
                }
            });
        },

        onEvent: function(callback) { this._onEventCallback = callback; },
        sendAction: function(actionName, payload = {}) {
            if (!this.socket) return;
            this.socket.emit('data', { action: actionName, ...payload });
        },

        // --- MÓDULO DE BASE DE DATOS (NUEVO) ---
        _dbCallbacks: {}, // Cola de callbacks de peticiones pendientes

        db: {
            // Helper interno para pedir datos
            _request: function(bucket, key, callback) {
                if (!EngineSDK.socket) return;
                const reqId = Date.now().toString(36) + Math.random().toString(36).substr(2);
                
                // Guardamos el callback para ejecutarlo cuando vuelva la respuesta
                EngineSDK._dbCallbacks[reqId] = callback;

                EngineSDK.socket.emit('data', {
                    action: 'SYS_DB_GET',
                    reqId: reqId,
                    bucket: bucket, // 'public' o 'private'
                    key: key // Si es null, trae todo el JSON
                });
            },

            // Helper interno para guardar datos
            _save: function(bucket, key, value) {
                if (!EngineSDK.socket) return;
                EngineSDK.socket.emit('data', {
                    action: 'SYS_DB_SET',
                    bucket: bucket,
                    key: key,
                    value: value
                });
            },

            // API Pública
            getPublic: function(key, callback) { this._request('public', key, callback); },
            setPublic: function(key, value) { this._save('public', key, value); },
            
            getPrivate: function(key, callback) { this._request('private', key, callback); },
            setPrivate: function(key, value) { this._save('private', key, value); }
        },

        // Métodos Legacy (Compatibilidad)
        guardar: function(type, content, extra) { this.sendAction('SYS_SAVE', { type, content, extra }); },
        desconectar: function() { if (this.socket) this.socket.disconnect(); }
    };

    global.EngineSDK = EngineSDK;
})(window);