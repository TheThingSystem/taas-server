// TODO: send cookie to listener and expect same cookie back


var http       = require('http')
  , https      = require('https')
  , md5        = require('MD5')
  , net        = require('net')
  , portfinder = require('portfinder')
  , url        = require('url')
  ;


var maxport    = 1025;
var pairings   = {};
var responders = {};

exports.listen = function(options) {
  var host, httpsT, server;

  httpsT = (!!options.keyData) ? 'https' : 'http';
  server = (!!options.keyData) ? https.createServer({ key: options.keyData, cert: options.crtData }) : http.createServer();
  nextPort(options.taasPort);

  server.on('request', function(request, response) {
    var auth, params, pathname, tag, tokens, x, y;

    pathname = url.parse(request.url).pathname;
    tag = httpsT + ' ' + request.connection.remoteAddress + ' ' + request.connection.remotePort + ' ' + request.method;
    options.logger.info(tag, { event: 'request', path: pathname });

    if (!request.headers.host) {
      options.logger.info(tag, { event: 'missing host', code: 404, path: pathname });
      response.writeHead(404);
      return response.end();
    }

    host = request.headers.host;
    x = host.indexOf(':');
    if (x > 0) host = host.substring(0,x);

    if (host !== options.namedRegistrar) return client(options, httpsT, tag, host, request, response);

    if (!request.headers.authorization) {
      options.logger.info(tag, { event: 'no authorization method', code: 401 });
      response.writeHead(401, { 'www-authenticate': 'TOTP realm="taas", '
                                                  + 'qop="auth, auth-int", '
                                                  + 'nonce="'  + md5(new Date().getTime()) + '", '
                                                  + 'opaque="' + md5('taas') + '"'
                              });
      return response.end();
    }

    auth = request.headers.authorization;
    try {
      x = auth.indexOf(' ');
      if (x === -1) throw new Error('no space in authentication header: ' + auth);
      if (auth.slice(0, x) !== 'TOTP') throw new Error('unknown authentication type in authentication header: ' + auth);

      // parsing from https://github.com/gevorg/http-auth/blob/master/lib/auth/digest.js, thanks!!!
      auth = auth.replace(/\\"/g, "&quot;").replace(/(\w+)=([^," ]+)/g, '$1=\"$2\"');
      tokens = auth.match(/(\w+)="([^"]*)"/g);

      params = {};
      for (x = 0; x < tokens.length; x++) {
        y = tokens[x].indexOf('=');
        if (y < 1) continue;
        params[tokens[x].substring(0, y)] = tokens[x].slice(y + 2, -1);
      }
      if (!params.username) throw new Error('no username parameter');
      if (!params.response) throw new Error('no response parameter');
    } catch(ex) {
      options.logger.info(tag, { event: 'invalid authorization'
                               , code: 400
                               , authorization: request.headers.authorization
                               , diagnostic: ex.message
                               });
      response.writeHead(400);
      return response.end();
    }

    options.lookup(options, params, function(err, labels) {
      var label, x;

      if (err) {
        options.logger.info(tag, { event: err.message, code: 400, authorization: request.headers.authorization });
        response.writeHead(400);
        return response.end();
      }

      if (request.method === 'GET') {
      if (pathname.indexOf('/pairings/') !== 0) {
          options.logger.info(tag, { event: 'invalid path', code: 404, path: pathname });
          response.writeHead(404);
          return response.end();
        }

        label = pathname.substring(10);
        x = labels.indexOf(label);
        if (x < 0) {
          options.logger.info(tag, { event: 'invalid path', code: 404, label: label });
          response.writeHead(404);
          return response.end();
        }

        response.writeHead(200, { 'Content-Type' : 'application/json' });
        return response.end(JSON.stringify(pairings[label] || []));

      } else if (request.method !== 'PUT') {
        options.logger.info(tag, { event: 'invalid method', code: 405, method: request.method });
        response.writeHead(405, { Allow: 'PUT' });
        return response.end();
      }

      if (pathname.indexOf('/register/') !== 0) {
        options.logger.info(tag, { event: 'invalid path', code: 404, path: pathname });
        response.writeHead(404);
        return response.end();
      }

      label = pathname.substring(10);
      x = labels.indexOf(label);
      if (x < 0) {
        options.logger.info(tag, { event: 'invalid path', code: 404, label: label });
        response.writeHead(404);
        return response.end();
      }

      portfinder.getPort({ port: maxport }, function(err, portno) {
        var didP, plug;

        if (err) {
          options.logger.error(tag, { event: 'portfinder', code: 500, diagnostic: err.message, label: label });
          response.writeHead(500);
          return response.end();
        }
        nextPort(portno);

        didP = false;
        plug = net.createServer({ allowHalfOpen: true }, function(socket) {
          var check = function() {
            var i, responder;

            for (i = 0; i < responders[label].length; i++) {
              responder = responders[label][i];

              if (responder.socket === socket) {
                try { responder.socket.destroy(); } catch(ex) {}
                responders[label].splice(i, 1);
                break;
              }
            }
          };

          if (didP) {
            options.logger.warning(tag, { event: 'multiple connections', label: label });
            try { socket.destroy(); } catch(ex) {}
            return;
          }
          didP = true;
          try {
            plug.close(function() {
              options.logger.debug(tag, { event: 'accepted', label: label });
            });
          } catch(ex) {}

          if (!responders[label]) responders[label] = [];
          else while (responders[label].length > 5) {
            try { (responders[label].shift()).socket.destroy(); } catch(ex) {}
          }
          responders[label].push({ socket: socket, tag: tag });

          socket.setNoDelay(true);
          socket.setKeepAlive(true);

          socket.on('data', function(data) {/* jshint unused: false */
          }).on('error', function(err) {
            options.logger.error(tag, { event: 'listener error', diagnostic: err.message, label: label });
            check(); // probably, not needed...
          }).on('end', function () {
            options.logger.debug(tag, { event: 'listener end', label: label });
            check();
          }).on('close', function(errorP) {
            if (errorP) options.logger.error(tag, { event: 'listener close', label: label });
            else        options.logger.debug(tag, { event: 'listener close', label: label });
          });
        }).listen(portno, options.taasHost, 1, function () {
          var endpoint = options.taasHost + ':' + portno;

          options.logger.info(tag, { event: 'listen', code: 200, endpoint: endpoint, label: label });
          response.writeHead(200);
          response.end(endpoint);

          setTimeout(function() {
            try {
              plug.close(function() {
                options.logger.info(tag, { event: 'inactivity', label: label });
              });
            } catch(ex) {}
          }, 30 * 1000);
        });
      });
    });
  }).on('clientError',function(err, socket) {/* jshint unused: false */
    options.logger.info('taas', { event: 'clientError', diagnostic: err.message });
  }).listen(options.taasPort, options.taasHost, function() {
    options.logger.info('listening on http' + ((!!options.keyData) ? 's' : '') + '://' + options.taasHost + ':'
                        + options.taasPort);
  });
};

var client = function(options, httpsT, tag, host, request, response) {
  var label;

  label = subdomainP(options, host);
  if (!label) {
    options.logger.warning(tag, { event: 'invalid Host', code: 503, host: request.headers.host });
    response.writeHead(503);
    return response.end();
  }

  if (!responders[label]) {
    options.logger.info(tag, { event: 'no responders', code: 503, host: request.headers.host });
    response.writeHead(503);
    return response.end();
  }

  portfinder.getPort({ port: maxport }, function(err, portno) {
    var didP, plug, u;

    if (err) {
      options.logger.error(tag, { event: 'portfinder', code: 500, label: label, diagnostic: err.message });
      response.writeHead(500);
      return response.end();
    }
    nextPort(portno);

    didP = false;
    u = url.parse(request.url);
    plug = net.createServer({ allowHalfOpen: true }, function(socket) {
      var responder;

// we allow multiple connections to this end-point...

      responder = responders[label].shift();
      if (!responder) {
        options.logger.error(tag, { event: 'no responder', label: label });
        return socket.destroy();
      }

      socket.setNoDelay(true);
      socket.setKeepAlive(true);

      if (!pairings[label]) pairings[label] = [];
      pairings[label].push({ responder: responder.tag, initiator: tag, pathname: u.pathname, timestamp: new Date().getTime() });
      if (pairings[label].length > 100) pairings[label].splice(0,100);

      socket.pipe(responder.socket).pipe(socket);
    }).listen(portno, options.taasHost, 511, function () {
      var location = httpsT + '://' + options.taasHost + ':' + portno;

      if (!!u.pathname) location += u.pathname;
      if (!!u.hash)     location += u.hash;
      options.logger.info(tag, { event: 'listen', code: 307, location: location, label: label });

      response.writeHead(307, { location: location, 'content-length' : 0 });
      return response.end();
    });
  });
};

var subdomainP = function(options, domain) {
  var suffix, x;

  suffix = '.' + options.namedServers;
  x = domain.lastIndexOf(suffix);
  if ((x <= 0) || ((domain.length - x) !== suffix.length)) return null;
  return domain.substring(0, x);
};

var nextPort = function(lastPort) {
  maxport = lastPort + 1;

  if ((maxport < 1025) || (maxport > 63000)) maxport = 1025;
  maxport += Math.round(Math.random() * 2048);
};
