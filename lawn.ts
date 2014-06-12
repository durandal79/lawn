///<reference path="defs/socket.io.extension.d.ts"/>
///<reference path="defs/express.d.ts"/>
/// <reference path="lib/references.ts"/>

import when = require('when')
import MetaHub = require('vineyard-metahub')
import Ground = require('vineyard-ground')
import Vineyard = require('vineyard')

declare var Irrigation

interface User_Source {
  name:string
  username:string
  password:string
  email?:string
  phone?:string
  gender?:string
  facebook_token?:string
  image?:string
  address?
}

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

  emit_to_users(users, name, data):Promise {
    return this.vineyard.bulbs.songbird.notify(users, name, data)
  }

  notify(users, name, data, trellis_name:string):Promise {
    return this.vineyard.bulbs.songbird.notify(users, name, data, trellis_name)
  }

  get_user_sockets(id:number):Socket[] {
    return MetaHub.map_to_array(this.instance_user_sockets[id], (x)=> x)
      || []
  }

  initialize_session(socket, user) {
    this.instance_sockets[socket.id] = socket
    this.instance_user_sockets[user.id] = this.instance_user_sockets[user.id] || []
    this.instance_user_sockets[user.id][socket.id] = socket
    this.ground.db.query('UPDATE users SET online = 1 WHERE id = ' + user.id)

    socket.join('user/' + user.id)

    socket.on('query', (request, callback)=>
        Lawn.Irrigation.process('query', request, user, this.vineyard, socket, callback)
    )

    socket.on('update', (request, callback)=>
        Lawn.Irrigation.process('update', request, user, this.vineyard, socket, callback)
    )

    this.on_socket(socket, 'room/join', user, (request)=> {
        console.log('room/join', user.id, request)
        socket.join(request.room)
      }
    )

    this.on_socket(socket, 'room/leave', user, (request)=> {
        console.log('room/leave', user.id, request)
        socket.leave(request.room)
      }
    )

    this.on_socket(socket, 'room/emit', user, (request)=> {
        console.log('room/emit', user.id, request)
        socket.broadcast.to(request.room).emit(request.event_name, request.data) //emit to 'room' except this socket
      }
    )

    user.online = true
    this.invoke('socket.add', socket, user)

    console.log(process.pid, 'Logged in: ' + user.id)
  }

  // Attach user online status to any queried users
  query_user(user, query:Ground.Query_Builder) {
//    console.log('modifying query')
    if (!this.io)
      return

    var clients = this.io.sockets.clients(user.id)
//    console.log('modifying query', clients.length)
//    user.online = clients.length > 0
  }

  start() {
    return this.ground.db.query("UPDATE users SET online = 0 WHERE online = 1")
      .then(()=> {
        this.start_http(this.config.ports.http);
        this.start_sockets(this.config.ports.websocket);
      })
  }

  static public_user_properties = [ 'id', 'name', 'username', 'email' ]
  static internal_user_properties = Lawn.public_user_properties.concat([ 'roles' ])

  private static is_ready_user_object(user) {
    var properties = Lawn.public_user_properties
    for (var i = 0; i < properties.length; ++i) {
      if (user[properties[i]] === undefined)
        return false
    }

    return true
  }

  private static format_public_user(user) {
    return MetaHub.extend({}, user, Lawn.public_user_properties)
  }

  private static format_internal_user(user) {
    return MetaHub.extend({}, user, Lawn.internal_user_properties)
  }

  get_public_user(user):Promise {
    if (typeof user == 'object') {
      if (Lawn.is_ready_user_object(user)) {
        return when.resolve(Lawn.format_public_user(user))
      }
    }

    var id = typeof user == 'object' ? user.id : user
    var query = this.ground.create_query('user')
    query.add_key_filter(id)
    return query.run_single()
      .then((user)=> Lawn.format_public_user(user))
  }


  get_schema(req, res, user) {
    var fortress = this.vineyard.bulbs.fortress
    var response = fortress.user_has_role(user, 'admin')
      ? this.ground.export_schema()
      : {}

    res.send(response)
  }

  get_user_from_session(token:string):Promise {
    var query = this.ground.create_query('session')
    query.add_key_filter(token)
    query.add_subquery('user').add_subquery('roles')

    return query.run_single()
      .then((session) => {
        console.log('session', session)
        if (!session)
          throw new Lawn.HttpError('Session not found.', 401)

        if (session.token === 0)
          throw new Lawn.HttpError('Invalid session.', 401)

        if (typeof session.user !== 'object')
          throw new Lawn.HttpError('User not found.', 401)

        var user = session.user

        return Lawn.format_internal_user(user)
      })
  }

  http_login(req, res, body):Promise {

    if (typeof body.facebook_token === 'string')
      return this.vineyard.bulbs.facebook.login(req, res, body)

    console.log('login', body)
    return this.ground.db.query("SELECT id, name FROM users WHERE username = ? AND password = ?", [body.name, body.pass])
      .then((rows)=> {
        if (rows.length == 0) {
          throw new Lawn.HttpError('Invalid login info.', 400)
        }

        var user = rows[0];
        this.invoke('user.login', user)
          .then(()=> {
            return Lawn.create_session(user, req, this.ground)
              .then(()=> this.send_http_login_success(req, res, user))
          })
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

  send_http_login_success(req, res, user) {
    var query = this.ground.create_query('user')
    query.add_key_filter(user.id)
    query.run_single()
      .then((row)=> {
        res.send({
          token: req.sessionID,
          message: 'Login successful2',
          user: Lawn.format_internal_user(row)
        })
      })
  }


  register(req, res):Promise {
    var body = <User_Source>req.body,
      name = body.name,
      username = body.username,
      email = body.email,
      phone = body.phone,
      facebook_token = body.facebook_token

    var invalid_characters = /[^A-Za-z\- _0-9]/

    if (!name)
      return when.reject(new Lawn.HttpError('Request missing name.', 400))

    if (typeof name != 'string' || name.length > 32 || name.match(invalid_characters))
      return when.reject(new Lawn.HttpError('Invalid name.', 400))

    if (typeof username != 'string' || username.length > 32 || name.match(invalid_characters))
      return when.reject(new Lawn.HttpError('Invalid username.', 400))

    if (email && (!email.match(/\S+@\S+\.\S/) || email.match(/['"]/)))
      return when.reject(new Lawn.HttpError('Invalid email address.', 400))

    var register = (facebook_id = undefined)=> {
      var args = [ body.name ]
      var sql = "SELECT 'username' as value FROM users WHERE username = ?"
      if (body.email) {
        sql += "\nUNION SELECT 'email' as value FROM users WHERE email = ?"
        args.push(body.email)
      }

      if (facebook_id) {
        sql += "\nUNION SELECT 'facebook_id' as value FROM users WHERE facebook_id = ?"
        args.push(facebook_id)
      }

      return this.ground.db.query(sql, args)
        .then((rows)=> {
          if (rows.length > 0)
            return when.reject(new Lawn.HttpError('That ' + rows[0].value + ' is already taken.', 400))

          // Not so worried about invalid gender, just filter it
          var gender = body.gender
          if (gender !== 'male' && gender !== 'female')
            gender = null

          var user = {
            name: name,
            username: username,
            email: email,
            password: body.password,
            gender: gender,
            phone: phone,
            roles: [ 2 ],
            address: body.address,
            image: body.image
          }
          console.log('user', user, facebook_id)
          this.ground.create_update('user', user).run()
            .then((user)=> {
              var finished = ()=> {
                user.facebook_id = facebook_id
                res.send({
                  message: 'User ' + name + ' created successfully.',
                  user: user
                })
              }
              if (facebook_id)
                return this.ground.db.query_single("UPDATE users SET facebook_id = ? WHERE id = ?", [facebook_id, user.id])
                  .then(finished)

              finished()
            })
        })
    }

    if (facebook_token !== undefined) {
      return this.vineyard.bulbs.facebook.get_user_facebook_id(body)
        .then((facebook_id)=> register(facebook_id))
    }
    else {
      return register()
    }
  }

  link_facebook_user(req, res, user):Promise {
    var body = req.body
    if (body.facebook_token === null || body.facebook_token === '') {
//      if (!user.facebook_id) {
//        res.send({
//          message: "Your account is already not linked to a facebook account.",
//          user: user
//        });
//        return when.resolve()
//      }

      console.log('connect-fb-user-detach', user)
      delete user.facebook_id
      return this.ground.db.query_single("UPDATE users SET facebook_id = NULL WHERE id = ?", [user.id])
        .then(()=> {
          res.send({
            message: 'Your user accont and facebook account are now detached.',
            user: user
          });
        })
    }
    return this.vineyard.bulbs.facebook.get_user_facebook_id(body)
      .then((facebook_id)=> {
        var args = [ body.name ]
        var sql = "SELECT 'username' as value, FROM users WHERE username = ?"
        if (body.email) {
          sql += "UNION SELECT 'email' as value FROM users WHERE email = ?"
          args.push(body.email)
        }

        if (facebook_id) {
          sql += "UNION SELECT 'facebook_id' as value FROM users WHERE facebook_id = ?"
          args.push(facebook_id)
        }

//        return this.ground.db.query_single("SELECT id, name FROM users WHERE facebook_id = ?", [facebook_id])
//          .then((row)=> {
//            if (row)
//              return when.reject(new Lawn.HttpError('That facebook id is already attached to a user.', 400))

        console.log('connect-fb-user', {
          id: user.id,
          facebook_id: facebook_id,
        })
        return this.ground.db.query_single("UPDATE users SET facebook_id = NULL WHERE facebook_id = ?", [facebook_id])
          .then(()=> this.ground.db.query_single("UPDATE users SET facebook_id = ? WHERE id = ?", [facebook_id, user.id]))
          .then(()=> {
            user.facebook_id = facebook_id
            res.send({
              message: 'Your user accont is now attached to your facebook account.',
              user: user
            });
          })
//          })
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
    if (!data.token) {
      socket.emit('error', { message: 'Missing token.' })
    }

    var query = this.ground.create_query('session')
    query.add_key_filter(data.token)

    this.get_user_from_session(data.token)
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
    ).done()

  }

  on_connection(socket:ISocket) {
    console.log('connection attempted')
    socket.on('login', (data, callback)=> this.login(data, socket, callback));

    socket.emit('connection');
    return socket.on('disconnect', () => {
      var data, user;
      this.debug('***detected disconnect');
      user = socket.user;
      if (user)
        delete this.instance_user_sockets[user.id][socket.id]

      delete this.instance_sockets[socket.id];
      if (user && this.get_user_sockets(user.id).length == 0) {
        this.debug(user.id);
        data = user
        if (this.ground.db.active)
          return this.ground.db.query('UPDATE users SET online = 0 WHERE id = ' + user.id)
//        data.online = false;
//        return Server.notify.send_online_changed(user, false);
      }

      return when.resolve()
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
      callback = callback || function () {
      }
      try {
        var promise = action(request)
        if (promise && typeof promise.done == 'function') {
          promise.done((response)=> {
              response = response || {}
              response.status = response.status || 200
              callback(response)
            },
            (error)=> callback(this.process_error(error, user))
          )
        }
        else {
          callback({ status: 200 })
        }
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

  listen_public_http(path, action, method = 'post') {
    this.app[method](path, (req, res)=>
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
//        console.log('server recieved query request.')
        this.process_user_http(req, res, action)
      }
    )
  }

  start_sockets(port = null) {
    var socket_io = require('socket.io')
    port = port || this.config.ports.websocket
    console.log('Starting Socket.IO on port ' + port)

    var io = this.io = socket_io.listen(port)
    io.set('log level', 1);
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
    var filepath = path.join(this.vineyard.root_path, this.config.file_path || 'files', guid + '.' + ext)
    console.log(filepath)
    return Lawn.file_exists(filepath)
      .then((exists)=> {
        if (!exists)
          throw new Lawn.HttpError('File Not Found', 404)
//          throw new Error('File Not Found')

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

    if (typeof this.config.mysql_session_store == 'object') {
      var MySQL_Session_Store = require('express-mysql-session')
      var storage_config = <Lawn.Session_Store_Config>this.config.mysql_session_store

      console.log('using mysql sessions store: ', storage_config.db)

      app.use(express.session({
        key: storage_config.key,
        secret: storage_config.secret,
        store: new MySQL_Session_Store(storage_config.db)
      }))
    }
    else {
      if (!this.config.cookie_secret)
        throw new Error('lawn.cookie_secret must be set!')

      app.use(express.session({secret: this.config.cookie_secret}))
    }

    // Log request info to a file
    if (typeof this.config.log_file === 'string') {
      var fs = require('fs')
      var log_file = fs.createWriteStream(this.config.log_file, {flags: 'a'})
      app.use(express.logger({stream: log_file}))
    }

    this.listen_public_http('/vineyard/login', (req, res)=> this.http_login(req, res, req.body))
    this.listen_public_http('/vineyard/login', (req, res)=> this.http_login(req, res, req.query), 'get')
    this.listen_user_http('/vineyard/query', (req, res, user)=> {
      console.log('server recieved query request.')
      return Lawn.Irrigation.query(req.body, user, this.ground, this.vineyard)
        .then((result)=> {
          if (!result.status)
            result.status = 200

          result.message = 'Success'
          res.send(result)
        })
    })
    this.listen_user_http('/vineyard/update', (req, res, user)=> {
      console.log('server recieved query request.')
      return Lawn.Irrigation.update(req.body, user, this.ground, this.vineyard)
        .then((result)=> {
          if (!result.status)
            result.status = 200

          result.message = 'Success'
          res.send(result)
        })
    })

    this.listen_user_http('/vineyard/current-user', (req, res, user)=> {
      res.send({
        status: 200,
        user: Lawn.format_public_user(user)
      })
      return when.resolve()
    }, 'get')

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
      var filepath = (this.config.file_path || 'files') + '/' + filename
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

    this.listen_public_http('/vineyard/register', (req, res)=> this.register(req, res))
    this.listen_user_http('/file/:guid.:ext', (req, res, user)=> this.file_download(req, res, user), 'get')
    this.listen_user_http('/vineyard/facebook/link', (req, res, user)=> this.link_facebook_user(req, res, user), 'post')
    this.listen_user_http('/vineyard/schema', (req, res, user)=> this.get_schema(req, res, user), 'get')

    port = port || this.config.ports.http
    console.log('HTTP listening on port ' + port + '.')

    this.invoke('http.start', app, this)
    this.http = app.listen(port)
  }

  stop() {
    console.log('Stopping Lawn')
    // Socket IO's documentation is a joke.  I had to look on stack overflow for how to close a socket server.
    if (this.io && this.io.server) {
      console.log('Stopping Socket.IO')
      var clients = this.io.sockets.clients()
      for (var i in clients) {
        clients[i].disconnect()
      }
      this.io.server.close()
      this.io = null
    }

    if (this.redis_client) {
      this.redis_client.quit()
      this.redis_client = null
    }

    if (this.http) {
      console.log('Closing HTTP.')
      this.http.close()
      this.http = null
      this.app = null
    }

    console.log('Lawn is stopped.')
  }
}

module Lawn {

  export interface Session_Store_DB {
    host:string
    port:number
    user:string
    password:string
    database:string
  }

  export interface Session_Store_Config {
    key:string
    secret:string
    db: Session_Store_DB
  }

  export interface Config {
    ports
    log_updates?:boolean
    use_redis?:boolean
    cookie_secret?:string
    log_file?:string
    admin
    file_path?:string
    mysql_session_store?:Session_Store_Config
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
        .then((result)=> {
          result.status = 200
          result.message = 'Success'
          if (callback)
            callback(result)
          else if (method != 'update')
            socket.emit('error', {
              status: 400,
              message: 'Query requests need to ask for an acknowledgement',
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
            return query.run()
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
              .then((objects)=> {
                return {
                  objects: objects
                }
              })
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
        })
    }

    login(req, res, body):Promise {
      console.log('facebook-login', body)

      return this.get_user(body)
        .then((user)=> {
          return Lawn.create_session(user, req, this.ground)
            .then(()=> this.lawn.send_http_login_success(req, res, user))
        })
    }

    get_user(body):Promise {
      return this.get_user_facebook_id(body)
        .then((facebook_id)=> {
          console.log('fb-user', facebook_id)
          if (!facebook_id) {
            return when.resolve(new Lawn.HttpError('Invalid facebook login info.', 400))
          }

          return this.ground.db.query_single("SELECT id, name FROM users WHERE facebook_id = ?", [facebook_id])
            .then((user)=> {
              if (user)
                return user

              throw new Lawn.HttpError('That Facebook user id is not yet connected to an account.  Redirect to registration.', 300)
//              return when.reject({ status: 300, message: 'That Facebook user id is not yet connected to an account.  Redirect to registration.' })

//              var options = {
//                host: 'graph.facebook.com',
//                path: '/' + facebook_id + '?fields=name,username,gender,picture'
//                  + '&access_token=' + body.facebook_token,
//                method: 'GET'
//              }
//
//              return Lawn.request(options, null, true)
//                .then((response) => {
//                  console.log('fb-user', response.content)
//                  return this.create_user(facebook_id, response.content)
//                })
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
      this.listen(this.lawn, 'socket.add', (socket, user)=> this.initialize_socket(socket, user))
    }

    initialize_socket(socket, user) {
      this.lawn.on_socket(socket, 'notification/received', user, (request)=>
          this.notification_receieved(user, request)
      )

      this.lawn.on_socket(socket, 'notification/received', user, (request)=>
          this.send_pending_notifications(user)
      )
    }

    notify(users, name, data, trellis_name:string, store = true):Promise {
      // With all the deferred action going on, this is sometimes getting hit
      // after the socket server has just shut down, so check if that is the case.

      var ground = this.lawn.ground
      var users = users.map((x)=> typeof x == 'object' ? x.id : x)

      if (!store) {
        if (!this.lawn.io)
          return when.resolve()

        for (var i = 0; i < users.length; ++i) {
          var id = users[i]
          console.log('sending-message', name, id, data)
          this.lawn.io.sockets.in('user/' + id).emit(name, data)
        }
      }
      data.event = name
      return ground.create_update(trellis_name, data, this.lawn.config.admin).run()
        .then((notification)=> {
          var promises = users.map((id)=> {
            console.log('sending-message', name, id, data)

            var online = this.lawn.io && this.lawn.io.sockets.clients(id) ? true : false

            return ground.create_update('notification_target', {
              notification: notification.id,
              recipient: id,
              received: online
            }, this.lawn.config.admin).run()
              .then(()=> {
                if (this.lawn.io)
                  this.lawn.io.sockets.in('user/' + id).emit(name, data)
              })
          })

          return when.all(promises)
        })
    }

    notification_receieved(user, request):Promise {
      var ground = this.lawn.ground
      var query = ground.create_query('notification_target')
      query.add_filter('recipient', user)
      query.add_filter('notification', request.notification)
      return query.run_single()
        .then((object)=> {
          if (!object)
            throw new Lawn.HttpError('Could not find a notification with that id and target user.', 400)

          if (object.received)
            throw new Lawn.HttpError('That notification was already marked as received.', 400)

          return ground.update_object('notification_target', {
            id: object.id,
            received: true
          })
            .then((object)=> {
              return { message: "Notification is now marked as received."}
            })
        })
    }

    send_pending_notifications(user) {
      var ground = this.lawn.ground
      var query = ground.create_query('notification_target')
      query.add_filter('recipient', user)
      query.add_filter('received', false)
      query.run()
        .done((objects)=> {
          for (var i = 0; i < objects.length; ++i) {
            var notification = objects[i].notification
            this.lawn.io.sockets.in('user/' + user.id).emit(notification.event, notification.data)
          }
        })
    }
  }
}

export = Lawn