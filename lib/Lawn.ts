///<reference path="../defs/socket.io.extension.d.ts"/>
///<reference path="../defs/express.d.ts"/>
/// <reference path="references.ts"/>

declare var Irrigation

class Lawn extends Vineyard.Bulb {
  io // Socket IO
  instance_sockets = {}
  instance_user_sockets = {}
  app
  fs
  config:Lawn.Config
  redis_client
  http
  debug_mode:boolean = false

  grow() {
    var ground = this.ground

    if (this.config.log_updates) {
      this.listen(ground, '*.update', (seed, update:Ground.Update):Promise => {
        // Don't want an infinite loop
        if (update.trellis.name == 'update_log')
          return when.resolve()

        return this.ground.insert_object('update_log', {
          user: update.user,
          data: JSON.stringify(seed),
          trellis: update.trellis.name
        })
      })
    }

    this.listen(ground, 'user.queried', (user, query:Ground.Query_Builder)=> this.query_user(user, query))
  }

  static
    authorization(handshakeData, callback) {
    return callback(null, true);
  }

  debug(...
          args:any[]) {
    var time = Math.round(new Date().getTime() / 10);
    var text = args.join(', ');
    console.log(text)
//      return this.ground.db.query("INSERT INTO debug (source, message, time) VALUES ('server', '" + text + "', " + time + ")");
  }

  emit_to_users(users, name, data) {
    this.vineyard.bulbs.songbird.notify(users, name, data)
  }

  get_user_socket(id:number):Socket {
    return this.instance_user_sockets[id]
  }

  initialize_session(socket, user) {
    this.instance_sockets[socket.id] = socket
    this.instance_user_sockets[user.id] = socket
    socket.join(user.id)

    socket.on('query', (request, callback)=>
        Irrigation.process('query', request, user, this.vineyard, socket, callback)
    )

    socket.on('update', (request, callback)=>
        Irrigation.process('update', request, user, this.vineyard, socket, callback)
    )

    this.invoke('socket.add', socket, user)

    user.online = true

    console.log(process.pid, 'Logged in: ' + user.id)
  }

  // Attach user online status to any queried users
  query_user(user, query:Ground.Query_Builder) {
    if (!this.io)
      return

    var clients = this.io.sockets.clients(user.id)
    user.online = clients.length > 0
  }

  start() {
    this.start_http(this.config.ports.http);
    this.start_sockets(this.config.ports.websocket);
  }

  get_public_user(user):Promise {
    var id = typeof user == 'object' ? user.id : user
    var query = this.ground.create_query('user')
    query.add_key_filter(id)
    return query.run()
      .then((user)=> {
        delete user.password
        delete user.roles
        return user
      })
  }

  get_user_from_session(token:string):Promise {
    var query = this.ground.create_query('session')
    query.add_key_filter(token)
    query.add_subquery('user').add_subquery('roles')

    return query.run_single()
//      .then(()=> { throw new Error('Debug error') })
      .then((session) => {
        console.log('session', session)
        if (!session)
          throw new Lawn.HttpError('Session not found.', 400)

        if (session.token === 0)
          throw new Lawn.HttpError('Invalid session.', 400)

        if (typeof session.user !== 'object')
          throw new Lawn.HttpError('User not found.', 400)

        var user = session.user
        return {
          id: user.id,
          name: user.name,
          roles: user.roles
        }
      })
  }

  http_login(req, res, body):Promise {

    if (typeof body.facebook_token === 'string')
      return this.vineyard.bulbs.facebook.login(req, res, body)

    console.log('login', body)
    var mysql = require('mysql')
    return this.ground.db.query("SELECT id, name FROM users WHERE username = ? AND password = ?", [body.name, body.pass])
      .then((rows)=> {
        if (rows.length == 0) {
          throw new Lawn.HttpError('Invalid login info.', 400)
        }

        var user = rows[0];
        return Lawn.create_session(user, req, this.ground)
          .then(()=> Lawn.send_http_login_success(req, res, user))
      })
  }

  static create_session(user, req, ground):Promise {
    var ip = req.headers['x-forwarded-for'] ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      req.connection.socket.remoteAddress

    var session = [
      user.id,
      req.sessionID,
      ip,
      Math.round(new Date().getTime() / 1000)
    ]

    return ground.db.query("REPLACE INTO sessions (user, token, hostname, timestamp) VALUES (?, ?, ?, ?)", session)
      .then(() => session)
  }

  static send_http_login_success(req, res, user) {
    res.send({
      token: req.sessionID,
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name
      }
    })
  }

  static request(options, data = null, secure = false):Promise {
    var def = when.defer()
    var http = require(secure ? 'https' : 'http')
//    if (secure)
//      options.secureProtocol = 'SSLv3_method'

    var req = http.request(options, function (res) {
      res.setEncoding('utf8')
      if (res.statusCode != '200') {
        res.on('data', function (chunk) {
          console.log('client received an error:', res.statusCode, chunk)
          def.reject()
        })
      }
      else {
        res.on('data', function (data) {
          if (res.headers['content-type'] &&
            (res.headers['content-type'].indexOf('json') > -1
              || res.headers['content-type'].indexOf('javascript') > -1))
            res.content = JSON.parse(data)
          else
            res.content = data

          def.resolve(res)
        })
      }
    })

    if (data)
      req.write(JSON.stringify(data))

    req.end()

    req.on('error', function (e) {
      console.log('problem with request: ' + e.message);
      def.reject()
    })

    return def.promise
  }

  login(data, socket:ISocket, callback) {
    console.log('message2', data);
    if (!data.token)
      return socket.emit('error', { message: 'Missing token.' })

    var query = this.ground.create_query('session')
    query.add_key_filter(data.token)

    return this.get_user_from_session(data.token)
      .then((user)=> {
        this.initialize_session(socket, user);
        console.log('user', user)
        if (callback) {
          console.log('login callback called')
          callback(user)
        }
      },
      (error)=> {
        if (this.debug_mode) {
          console.log('error', error.message)
          console.log('stack', error.stack)
        }

        socket.emit('error', {
          'message': error.status == 500 || !error.message ? 'Error getting session.' : error.message
        })
      }
    )
  }

  on_connection(socket:ISocket) {
    console.log('connection attempted')
    socket.on('login', (data, callback)=> this.login(data, socket, callback));

    socket.emit('connection');
    return socket.on('disconnect', () => {
      var data, user;
      this.debug('***detected disconnect');
      user = socket.user;
      delete this.instance_sockets[socket.id];
      if (user && !this.get_user_socket(user.id)) {
        this.debug(user.id);
        data = user
        data.online = false;
//        return Server.notify.send_online_changed(user, false);
      }
    });
  }

  static process_public_http(req, res, action) {
    action(req, res)
      .done(()=> {
      }, (error)=> {
        error = error || {}
        var status = error.status || 500
        var message = status == 500 ? 'Server Error' : error.message
        res.json(status || 500, { message: message })
      })
  }

  on_socket(socket, event, user, action) {
    socket.on(event, (request, callback)=> {
      try {
        var promise = action(request)
        if (promise && typeof promise.done == 'function')
          promise.done((response)=> {
              response = response || {}
              response.status = response.status || 200
              callback(response)
            },
            (error)=> callback(this.process_error(error, user))
          )
      }
      catch (err) {
        callback(this.process_error(err, user))
      }
    })
  }

  static listen_public_http(app, path, action, method = 'post') {
    app[method](path, (req, res)=>
        Lawn.process_public_http(req, res, action)
    )
  }

  process_error(error, user) {
    var status = error.status || 500
    var message = status == 500 ? 'Server Error' : error.message

    var response = {
      status: status,
      message: message
    }

    var fortress = this.vineyard.bulbs.fortress
    if (user && fortress && fortress.user_has_role(user, 'admin')) {
      response.message = error.message || "Server Error"
      response['stack'] = error.stack
      response['details'] = error.details
    }

    console.log('service error:', status, error.message, error.stack)

    return response
  }

  process_user_http(req, res, action) {
    var user = null, send_error = (error)=> {
      console.log('yeah')
      var response = this.process_error(error, user)
      var status = response.status
      delete response.status
      res.json(status, response)
    }
    try {
      this.get_user_from_session(req.sessionID)
        .then((u)=> {
          user = u
          return action(req, res, user)
        })
        .done(()=> {
        }, send_error)
    }
    catch (error) {
      send_error(error)
    }
  }

  listen_user_http(path, action, method = 'post') {
    this.app[method](path, (req, res)=> {
        console.log('server recieved query request.')
        this.process_user_http(req, res, action)
      }
    )
  }

  start_sockets(port = null) {
    var socket_io = require('socket.io')
    port = port || this.config.ports.websocket
    console.log('Starting Socket.IO on port ' + port)

    var io = this.io = socket_io.listen(port)
    io.server.on('error', (e)=> {
      if (e.code == 'EADDRINUSE') {
        console.log('Port in use: ' + port + '.')
        this.io = null
      }
    })

    // Authorization
    io.configure(()=>
      io.set('authorization', Lawn.authorization))

    io.sockets.on('connection', (socket)=>this.on_connection(socket))

    if (this.config.use_redis) {
      console.log('using redis')
      var RedisStore = require('socket.io/lib/stores/redis')
        , redis = require("socket.io/node_modules/redis")
        , pub = redis.createClient()
        , sub = redis.createClient()
        , client = redis.createClient()

      io.set('store', new RedisStore({
        redisPub: pub, redisSub: sub, redisClient: client
      }))
    }
  }

  file_download(req, res, user) {
    var guid = req.params.guid;
    var ext = req.params.ext;
    if (!guid.match(/[\w\-]+/) || !ext.match(/\w+/))
      throw new Lawn.HttpError('Invalid File Name', 400)

    var path = require('path')
    var filepath = path.join(this.vineyard.root_path, 'files', guid + '.' + ext)
    console.log(filepath)
    return Lawn.file_exists(filepath)
      .then((exists)=> {
        if (!exists)
//          throw new Lawn.HttpError('File Not Found', 404)
          throw new Error('File Not Found2')

        var query = this.ground.create_query('file')
        query.add_key_filter(req.params.guid)
        var fortress = this.vineyard.bulbs.fortress

        fortress.query_access(user, query)
          .then((result)=> {
            if (result.access)
              res.sendfile(filepath)
            else
              throw new Lawn.HttpError('Access Denied', 403)
          })
      })
  }

  private static file_exists(filepath:string):Promise {
    var fs = require('fs'), def = when.defer()
    fs.exists(filepath, (exists)=> {
      def.resolve(exists)
    })
    return def.promise
  }

  start_http(port) {
    if (!port)
      return

    var express = require('express');
    var app = this.app = express();

    app.use(express.bodyParser({ keepExtensions: true, uploadDir: "tmp"}));
    app.use(express.cookieParser());
    if (!this.config.cookie_secret)
      throw new Error('lawn.cookie_secret must be set!')

    app.use(express.session({secret: this.config.cookie_secret}))

    // Log request info to a file
    if (typeof this.config.log_file === 'string') {
      var fs = require('fs')
      var log_file = fs.createWriteStream(this.config.log_file, {flags: 'a'})
      app.use(express.logger({stream: log_file}))
    }

    Lawn.listen_public_http(app, '/vineyard/login', (req, res)=> this.http_login(req, res, req.body))
    Lawn.listen_public_http(app, '/vineyard/login', (req, res)=> this.http_login(req, res, req.query), 'get')
//    app.post('/vineyard/login', (req, res)=> this.http_login(req, res, req.body))
//    app.get('/vineyard/login', (req, res)=> this.http_login(req, res, req.query))
    this.listen_user_http('/vineyard/query', (req, res, user)=> {
      console.log('server recieved query request.')
      return Irrigation.query(req.body, user, this.ground, this.vineyard)
        .then((objects)=> res.send({ message: 'Success', objects: objects })
      )
    })

    this.listen_user_http('/vineyard/upload', (req, res, user)=> {
      console.log('files', req.files)
      console.log('req.body', req.body)
      var info = JSON.parse(req.body.info)
      var file = req.files.file;
      var guid = info.guid;
      if (!guid)
        throw new Lawn.HttpError('guid is empty.', 400)

      if (!guid.match(/[\w\-]+/))
        throw new Lawn.HttpError('Invalid guid.', 400)

      var path = require('path')
      var ext = path.extname(file.originalFilename) || ''
      var filename = guid + ext
      var filepath = 'files/' + filename
      var fs = require('fs')
      fs.rename(file.path, filepath);

      // !!! Add check if file already exists
      return this.ground.update_object('file', {
        guid: guid,
        name: filename,
        path: file.path,
        size: file.size,
        extension: ext.substring(1),
        status: 1
      }, user)
        .then((object)=> {
          res.send({file: object})
          this.invoke('file.uploaded', object)
        })
    })

    this.listen_user_http('/file/:guid.:ext', (req, res, user)=> this.file_download(req, res, user), 'get')

    port = port || this.config.ports.http
    console.log('HTTP listening on port ' + port + '.')

    this.invoke('http.start', app, this)
    this.http = app.listen(port)
  }

  stop() {
    // Socket IO's documentation is a joke.  I had to look on stack overflow for how to close a socket server.
    if (this.io && this.io.server) {
      this.io.server.close()
      this.io = null
    }

    if (this.redis_client) {
      this.redis_client.quit()
      this.redis_client = null
    }

    if (this.http) {
      console.log('Closing HTTP connection.')
      this.http.close()
      this.http = null
      this.app = null
    }
  }
}

module Lawn {

  export interface Config {
    ports
    log_updates?:boolean
    use_redis?:boolean
    cookie_secret?:string
    log_file?:string
  }

  export interface Update_Request {
    objects:any[];
  }

  export class HttpError {
    name = "HttpError"
    message
    stack
    status
    details

    constructor(message:string, status = 500) {
      this.message = message
      this.status = status
    }
  }

  export class Authorization_Error extends HttpError {
    details

    constructor(message:string, details) {
      super(message, 403)
      this.details = details
    }
  }

  export class Irrigation {
    static process(method:string, request:Ground.External_Query_Source, user:Vineyard.IUser, vineyard:Vineyard, socket, callback):Promise {
      var fortress = vineyard.bulbs.fortress
      var action = Irrigation[method]
      return fortress.get_roles(user)
        .then(()=> action(request, user, vineyard.ground, vineyard))
        .then((objects)=> {
          if (callback)
            callback({ status: 200, 'message': 'Success', objects: objects })
          else if (method != 'update')
            socket.emit('error', {
              status: 400,
              message: 'Requests need to ask for an acknowledgement',
              request: request
            })
        },
        (error)=> {
//          if (callback)
//            callback({ code: 403, 'message': 'You are not authorized to perform this update.', objects: [],
//              unauthorized_object: error.resource})
//          else
          error = error || {}
          console.log('service error:', error.message, error.status, error.stack)
          var status = error.status || 500

          var response = {
            code: status,
            status: status,
            request: request,
            message: status == 500 ? "Server Error" : error.message
          }

          if (fortress.user_has_role(user, 'admin')) {
            response.message = error.message || "Server Error"
            response['stack'] = error.stack
            details: error.details
          }

          if (vineyard.bulbs.lawn.debug_mode)
            console.log('error', error.stack)

          socket.emit('error', response)
        })
    }

    static query(request:Ground.External_Query_Source, user:Vineyard.IUser, ground:Ground.Core, vineyard:Vineyard):Promise {
      if (!request)
        throw new HttpError('Empty request', 400)

      var trellis = ground.sanitize_trellis_argument(request.trellis);
      var query = new Ground.Query_Builder(trellis);

      query.extend(request)

      var fortress = vineyard.bulbs.fortress
      return fortress.query_access(user, query)
        .then((result)=> {
          if (result.access)
            return query.run();
          else
            throw new Authorization_Error('You are not authorized to perform this query', result)
        })
    }

    static update(request:Update_Request, user:Vineyard.IUser, ground:Ground.Core, vineyard:Vineyard):Promise {
      if (!MetaHub.is_array(request.objects))
        throw new HttpError('Update is missing objects list.', 400)

      var updates = request.objects.map((object)=>
          ground.create_update(object.trellis, object, user)
      )

      if (!request.objects)
        throw new HttpError('Request requires an objects array', 400);

      var fortress = vineyard.bulbs.fortress
      return fortress.update_access(user, updates)
        .then((result)=> {
          if (result.access) {
            var update_promises = updates.map((update) => update.run())
            return when.all(update_promises)
          }
          else
            throw new Authorization_Error('You are not authorized to perform this update', result)
        })


    }
  }

  export class Facebook extends Vineyard.Bulb {
    lawn:Lawn

    grow() {
      this.lawn = this.vineyard.bulbs.lawn
    }

    create_user(facebook_id, source):Promise {
      var user = {
        name: source.name,
        username: source.username,
        email: source.email,
        gender: source.gender,
        facebook_id: facebook_id
      }

      console.log('user', user)
      return this.ground.create_update('user', user).run()
        .then((user)=> {
          return {
            id: user.id,
            name: user.name,
            username: user.username
          }
//        res.send({
//          message: 'User ' + name + ' created successfully.',
//          user: user
//        });
        })
    }

    login(req, res, body):Promise {
      console.log('facebook-login', body)
      var mysql = require('mysql')

      return this.get_user(body)
        .then((user)=> {
          return Lawn.create_session(user, req, this.ground)
            .then(()=> Lawn.send_http_login_success(req, res, user))
        })
    }

    get_user(body):Promise {
      return this.get_user_facebook_id(body)
        .then((facebook_id)=> {
          console.log('fb-user', facebook_id)
          if (!facebook_id) {
            throw new Lawn.HttpError('Invalid facebook login info.', 400)
          }

          return this.ground.db.query_single("SELECT id, name FROM users WHERE facebook_id = ?", [facebook_id])
            .then((user)=> {
              if (user)
                return user

              var options = {
                host: 'graph.facebook.com',
                path: '/' + facebook_id + '?fields=name,username,gender,picture'
                  + '&access_token=' + body.facebook_token,
                method: 'GET'
              }

              return Lawn.request(options, null, true)
                .then((response) => {
                  console.log('fb-user', response.content)
                  return this.create_user(facebook_id, response.content)
                })
            })
        })
    }

    get_user_facebook_id(body):Promise {
      if (typeof body.facebook_token != 'string' && typeof body.facebook_token != 'number')
        throw new Lawn.HttpError('Requires either valid facebook user id or email address.', 400)

      var options = {
        host: 'graph.facebook.com',
        path: '/oauth/access_token?'
          + 'client_id=' + this.config['app'].id
          + '&client_secret=' + this.config['app'].secret
          + '&grant_type=client_credentials',
        method: 'GET'
      }

      return Lawn.request(options, null, true)
        .then((response) => {
          var url = require('url')
          var info = url.parse('temp.com?' + response.content, true)
          var access_token = info.query.access_token

          var post = {
            host: 'graph.facebook.com',
            path: '/debug_token?'
              + 'input_token=' + body.facebook_token
              + '&access_token=' + access_token,
            method: 'GET'
          }

          return Lawn.request(post, null, true)
        })
        .then((response) => {
          console.log('facebook-check', response.content)
          return response.content.data.user_id
        })
    }
  }

 export class Songbird extends Vineyard.Bulb {
    lawn:Lawn

    grow() {
      this.lawn = this.vineyard.bulbs.lawn
    }

    notify(users, name, data) {
      // With all the deferred action going on, this is sometimes getting hit
      // after the socket server has just shut down, so check if that is the case.
      if (!this.lawn.io)
        return

      var users = users.map((x)=> typeof x == 'object' ? x.id : x)

      var id
      for (var i = 0; i < users.length; ++i) {
        id = users[i]
        console.log('sending-message', name, id, data)
        this.lawn.io.sockets.in(id).emit(name, data)
      }
    }
  }
}