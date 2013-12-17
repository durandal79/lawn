var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var Lawn = (function (_super) {
    __extends(Lawn, _super);
    function Lawn() {
        _super.apply(this, arguments);
        this.instance_sockets = {};
        this.instance_user_sockets = {};
    }
    Lawn.prototype.grow = function () {
        var _this = this;
        if (this.config.log_updates) {
            this.listen(this.ground, '*.update', function (update, trellis) {
                if (trellis.name == 'update_log')
                    return when.resolve();

                return _this.ground.insert_object('update_log', {
                    user: update.user,
                    data: JSON.stringify(update.seed),
                    trellis: trellis.name
                });
            });
        }
    };

    Lawn.authorization = function (handshakeData, callback) {
        //      console.log('authorizing', handshakeData);
        return callback(null, true);
    };

    Lawn.prototype.debug = function () {
        var args = [];
        for (var _i = 0; _i < (arguments.length - 0); _i++) {
            args[_i] = arguments[_i + 0];
        }
        var time = Math.round(new Date().getTime() / 10);
        var text = args.join(', ');
        console.log(text);
        //      return this.ground.db.query("INSERT INTO debug (source, message, time) VALUES ('server', '" + text + "', " + time + ")");
    };

    Lawn.prototype.get_user_socket = function (id) {
        return this.instance_user_sockets[id];
    };

    Lawn.prototype.initialize_session = function (socket, user) {
        var _this = this;
        var _this = this;
        this.instance_sockets[socket.id] = socket;
        this.instance_user_sockets[user.id] = socket;
        socket.join('test room');

        socket.on('query', function (request, callback) {
            Irrigation.query(request, user, _this.ground, _this.vineyard).then(function (objects) {
                return callback({ code: 200, 'message': 'Success', objects: objects });
            }, function (error) {
                callback({ code: 403, 'message': 'You are not authorized to perform this query.', objects: [] });
                socket.emit('error', {
                    'code': 401,
                    'message': 'Unauthorized',
                    request: request
                });
            });
        });

        socket.on('update', function (request, callback) {
            console.log('vineyard update:', request);
            Irrigation.update(request, user, _this.ground, _this.vineyard).then(function (objects) {
                return callback({ code: 200, 'message': 'Success', objects: objects });
            }, function (error) {
                callback({ code: 403, 'message': 'You are not authorized to perform this update.', objects: [] });
                socket.emit('error', {
                    'code': 401,
                    'message': 'Unauthorized',
                    request: request
                });
            });
        });

        console.log(process.pid, 'Logged in: ' + user.id);
    };

    Lawn.prototype.start = function () {
        this.start_http(this.config.ports.http);
        this.start_sockets(this.config.ports.websocket);
    };

    Lawn.prototype.get_user_from_session = function (token) {
        var query = this.ground.create_query('session');
        query.add_key_filter(token);
        return query.run_single().then(function (session) {
            console.log('session', session);
            if (!session)
                return when.reject({ status: 401, message: 'Session not found.' });

            if (session.token === 0)
                return when.reject({ status: 401, message: 'Invalid session.' });

            if (typeof session.user !== 'object')
                return when.reject({ status: 401, message: 'User not found.' });

            return {
                id: session.user.id,
                name: session.user.name
            };
            //        var query = this.ground.create_query('user')
            //        query.add_key_filter(session.user)
            //        return query.run_single()
            //          .then((user_record) => {
            //            if (!user_record)
            //              return when.reject({status: 401, message: 'User not found.' })
            //
            //            return user_record
            //          });
        });
    };

    Lawn.prototype.login = function (data, socket, callback) {
        var _this = this;
        console.log('message2', data);
        if (!data.token)
            return socket.emit('error', { message: 'Missing token.' });

        var query = this.ground.create_query('session');
        query.add_key_filter(data.token);

        return this.get_user_from_session(data.token).then(function (user) {
            //            user.session = session;
            _this.initialize_session(socket, user);
            console.log('user', user);
            callback(user);
        }, function (error) {
            return socket.emit('error', {
                'message': 'Invalid session.'
            });
        });
    };

    Lawn.prototype.on_connection = function (socket) {
        var _this = this;
        console.log('connection attempted');
        socket.on('login', function (data, callback) {
            return _this.login(data, socket, callback);
        });

        socket.emit('connection');
        return socket.on('disconnect', function () {
            var data, user;
            _this.debug('***detected disconnect');
            user = socket.user;
            delete _this.instance_sockets[socket.id];
            if (user && !_this.get_user_socket(user.id)) {
                _this.debug(user.id);
                data = user;
                data.online = false;
                //        return Server.notify.send_online_changed(user, false);
            }
        });
    };

    Lawn.prototype.start_sockets = function (port) {
        if (typeof port === "undefined") { port = null; }
        var _this = this;
        var socket_io = require('socket.io');
        port = port || this.config.ports.websocket;
        console.log('Starting Socket.IO on port ' + port);

        var io = this.io = socket_io.listen(port);
        io.server.on('error', function (e) {
            if (e.code == 'EADDRINUSE') {
                console.log('Port in use: ' + port + '.');
                _this.io = null;
            }
        });

        // Authorization
        io.configure(function () {
            return io.set('authorization', Lawn.authorization);
        });

        io.sockets.on('connection', function (socket) {
            return _this.on_connection(socket);
        });

        if (this.config.use_redis) {
            console.log('using redis');
            var RedisStore = require('socket.io/lib/stores/redis'), redis = require("socket.io/node_modules/redis"), pub = redis.createClient(), sub = redis.createClient(), client = redis.createClient();

            io.set('store', new RedisStore({
                redisPub: pub,
                redisSub: sub,
                redisClient: client
            }));
        }
    };

    Lawn.prototype.start_http = function (port) {
        var _this = this;
        if (!port)
            return;

        var express = require('express');
        var app = this.app = express();

        app.use(express.bodyParser({ keepExtensions: true, uploadDir: "tmp" }));
        app.use(express.cookieParser());
        if (!this.config.cookie_secret)
            throw new Error('lawn.cookie_secret must be set!');

        app.use(express.session({ secret: this.config.cookie_secret }));

        if (typeof this.config.log_file === 'string') {
            var fs = require('fs');
            var log_file = fs.createWriteStream(this.config.log_file, { flags: 'a' });
            app.use(express.logger({ stream: log_file }));
        }

        var user;
        app.post('/vineyard/login', function (req, res) {
            _this.ground.db.query("SELECT id, name FROM users WHERE name = ? AND password = ?", [req.body.name, req.body.pass]).then(function (rows) {
                if (rows.length == 0) {
                    return res.status(401).send('Invalid login info.');
                }

                user = rows[0];

                var session = [
                    user.id,
                    req.sessionID,
                    req.host,
                    Math.round(new Date().getTime() / 1000)
                ];
                _this.ground.db.query("REPLACE INTO sessions (user, token, hostname, timestamp) VALUES (?, ?, ?, ?)", session).then(function () {
                    res.send({
                        token: req.sessionID,
                        message: 'Login successful',
                        user: {
                            id: user.id,
                            name: user.name
                        }
                    });
                });
            });
        });

        app.post('/vineyard/upload', function (req, res) {
            _this.get_user_from_session(req.sessionID).then(function (user) {
                console.log('files', req.files);
                console.log('req.body', req.body);
                var info = JSON.parse(req.body.info);
                var file = req.files.file;
                var guid = info.guid;
                if (!guid)
                    return res.status(401).send('guid is empty.');

                if (!guid.match(/[\w\-]+/))
                    return res.status(401).send('Invalid guid.');

                var path = require('path');
                var ext = path.extname(file.originalFilename);
                var filename = guid + ext;
                var filepath = 'files/' + filename;
                var fs = require('fs');
                fs.rename(file.path, filepath);

                // !!! Add check if file already exists
                _this.ground.update_object('file', {
                    guid: guid,
                    name: filename,
                    path: file.path,
                    size: file.size
                }, user).then(function (object) {
                    return res.send({ file: object });
                });
            }, function (error) {
                return res.status(error.status).send(error.message);
            });
        });

        app.get('/file/:guid.:ext', function (req, res) {
            var guid = req.params.guid;
            var ext = req.params.ext;
            if (!guid.match(/[\w\-]+/) || !ext.match(/\w+/)) {
                return res.status(401).send('Invalid File Name');
            }
            var fs = require('fs');
            var path = require('path');
            var filepath = path.join(__dirname, '../files', guid + '.' + ext);
            console.log(filepath);
            fs.exists(filepath, function (exists) {
                if (!exists)
                    return res.status(404).send('Not Found');

                var query = this.ground.create_query('file');
                query.add_key_filter(req.params.guid);
                var fortress = this.vineyard.bulbs.fortress;

                this.get_user_from_session(req.sessionID).then(function (user) {
                    return fortress.query_access(user, query);
                }).then(function (result) {
                    if (result.access)
                        res.sendfile(filepath);
else
                        res.status(403).send('Access Denied');
                }, res.status(500).send('Internal Server Error'));
                //          res.end()
            });
        });
        port = port || this.config.ports.http;
        console.log('HTTP listening on port ' + port + '.');

        this.http = app.listen(port);
    };

    Lawn.prototype.stop = function () {
        if (this.io && this.io.server) {
            this.io.server.close();
            this.io = null;
        }

        if (this.redis_client) {
            this.redis_client.quit();
            this.redis_client = null;
        }

        if (this.http) {
            console.log('Closing HTTP connection.');
            this.http.close();
            this.http = null;
            this.app = null;
        }
    };
    return Lawn;
})(Vineyard.Bulb);
//# sourceMappingURL=Lawn.js.map