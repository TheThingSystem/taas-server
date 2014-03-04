var bcrypt    = require('bcrypt')
  , fs        = require('fs')
  , http      = require('http')
  , redis     = require('redis')
  , speakeasy = require('speakeasy')
  , url       = require('url')
  , uuidX     = require('node-uuid')
  , options   = require('./vps').options
  ;


if (options.redisHost === '127.0.0.1') {
  require('nedis').createServer({ server: options.redisHost, port: options.redisPort }).listen(options.redisPort);
}

var client = redis.createClient(options.redisPort, options.redisHost, { parser: 'javascript' });
client.auth(options.redisAuth, function(err) {
  if (err) throw err;
});

var listenP = false;
client.on('ready', function() {
  client.keys('*', function(err, reply) {
    var i, key;

    if (err) return console.log('keys error: ' + err.message);

    for (i = 0; i < reply.length; i++) {
      key = reply[i];
      if (key.indexOf('_') === -1) fetch(key);
    }
  });

  if (listenP) return;

  http.createServer(function(request, response) {
    var content= '';
    request.setEncoding('utf8');
    request.on('data', function(chunk) {
      content += chunk.toString();
    }).on('close', function() {
      console.log('http error: premature close');
    }).on('end', function() {
      var parts = url.parse(request.url, true);

      if ((parts.pathname !== '/') && (parts.pathname !== 'index.html')) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        return response.end('404 not found');
      }

      if (request.method === 'GET') {
        fs.readFile('users.html', function(err, data) {
          var code, diagnostic;

          if (err) {
            if (err.code === 'ENOENT') {
              code = 404;
              diagnostic = '404 not found';
            } else {
              code = 404;
              diagnostic = err.message + '\n';
            }
            response.writeHead(code, { 'Content-Type': 'text/plain' });
            return response.end(diagnostic);
          }

          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end(data);
        });
        return;
      }

      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'GET, POST' });
        return response.end();
      }

      perform(response, parts.query);
    });
  }).listen(8893, '127.0.0.1', function() {
    listenP = true;
    console.log('listening on http://127.0.0.1:8893');
  });
}).on('connect',  function() {
}).on('error',  function(err) {
  throw err;
}).on('end',  function() {
});

var perform = function(response, query) {
  var i, label, labels, password, results, username, uuid;

  response.writeHead(200, { 'Content-Type': 'application/json' });
  switch (query.action) {
    case 'list':
      results = { result: { entries: entries }};
      break;

    case 'create':
      label = query.label.replace(/^\s+|\s+$/g, '');
      labels = (!!query.labels) ? query.labels.split(',') : [];
      for (i = 0; i < labels.length; i++) labels[i] = labels[i].replace(/^\s+|\s+$/g, '');
      uuid = normalize_uuid(query.uuid);
      if (!uuid) {
        results = { error: { permanent: true, diagnostic: 'invalid uuid parameter: ' + query.uuid } };
        break;
      }
      create_uuid(label, labels, uuid, function(err, reply) {/* jshint unused: false */
        if (err) {
          results = { error: { permanent: true, diagnostic: err.message } };
          return response.end(JSON.stringify(results));
        }

        fetch(uuid, function(err, entry) {
          if (err) results = { error:  { permanent: true, diagnostic: err.message } };
          else     results = { result: { entry    : entry }};
          return response.end(JSON.stringify(results));
        });
      });
      return;

    case 'delete':
      uuid = normalize_uuid(query.uuid);
      if (!uuid) {
        results = { error: { permanent: true, diagnostic: 'invalid uuid parameter: ' + query.uuid } };
        break;
      }
      client.del(uuid, function(err, reply) {/* jshint unused: false */
        if (err) {
          results = { error: { permanent: true, diagnostic: err.message } };
          return response.end(JSON.stringify(results));
        }

        delete(entries[uuid]);
        results = { result: { entries: entries }};
        return response.end(JSON.stringify(results));
      });
      return;

    case 'adduser':
      username = normalize_username(query.username);
      if (!username) {
        results = { error: { permanent: true, diagnostic: 'invalid username parameter: ' + query.username } };
        break;
      }
      password = query.password;
      if ((!password) || (password.length < 12)) {
        results = { error: { permanent: true, diagnostic: 'invalid password parameter: ' + query.password } };
        break;
      }
      create_username(label, username, password, function(err, reply) {/* jshint unused: false */
        if (err) {
          results = { error: { permanent: true, diagnostic: err.message } };
          return response.end(JSON.stringify(results));
        }

        fetch(username, function(err, entry) {
          if (err) results = { error:  { permanent: true, diagnostic: err.message } };
          else     results = { result: { entry    : entry }};
          return response.end(JSON.stringify(results));
        });
      });
      return;

    case 'deluser':
      username = normalize_username(query.username);
      if (!username) {
        results = { error: { permanent: true, diagnostic: 'invalid username parameter: ' + query.username } };
        break;
      }
      client.del(username, function(err, reply) {/* jshint unused: false */
        if (err) {
          results = { error: { permanent: true, diagnostic: err.message } };
          return response.end(JSON.stringify(results));
        }

        delete(entries[username]);
        results = { result: { entries: entries }};
        return response.end(JSON.stringify(results));
      });
      return;

    case undefined:
      results = { error: { permanent: true, diagnostic: 'missing action parameter' } };
      break;

    default:
      results = { error: { permanent: true, diagnostic: 'unknown action: ' + query.action } };
      break;
  }
  response.end(JSON.stringify(results));
};

var normalize_uuid = function(uuid) {
  var b = (!!uuid) ? uuidX.parse(uuid) : [];

  return ((b.length === 16) ? uuidX.unparse(b) : null);
};

var normalize_username = function(username) {
  var b;

  if ((!username) || (username.indexOf('#') !== -1) || (username.indexOf('+') !== -1) || (username.indexOf('*') !== -1)) {
    return null;
  }
  b = username.replace(/(([^/])\/+$)|(([^/]))|(\/+(\/))/g, '$2$4$6');

  return ((b.length > 0) ? b : null);
};


var entries = {};

var fetch = function(key, cb) {
  client.get(key, function(err, reply) {
    var entry = null;

    if (err) console.log('redis get error: ' + key + ': ' + err.message);
    try { entry = JSON.parse(reply); entries[key] = entry; } catch(ex) { console.log('parse error: ' + ex.message); }
    if (!!cb) cb(err, entry);
  });
};

var create_uuid = function(label, labels, uuid, cb) {
  var data, params, value;

  params = { length         : 40
           , random_bytes   : false
           , symbols        : false
           , google_auth_qr : true
           , name           : label + '.' + options.namedServers
           , issuer         : 'https://' + options.namedRegistrar
           };

  data = speakeasy.generate_key(params);
  data.params.base32 = data.base32;
  data.params.protocol = 'totp';

  if (labels.indexOf(label) === -1) labels.unshift(label);

  value = { uuid       : uuid
          , qrcodeURL  : data.google_auth_qr
          , authURL    : data.url()
          , authParams : data.params
          , labels     : labels
          };

  client.set(uuid, JSON.stringify(value), function(err, reply) {
    if (err) console.log('redis set error: ' + uuid + ': ' + err.message);
    cb(err, reply);
    if (err) return;

    data.params.uuid   = [ uuid ];
    data.params.labels = labels;
    data.params.server = { hostname : options.taasHost
                         , port     : options.taasPort
                         , ca       : options.crtData
                         };

    fs.writeFile(uuid + '.js', 'exports.params = ' + JSON.stringify(data.params) + ';\n', { mode: 0644 }, function(err) {
      if (err) console.log('file write error: ' + uuid + '.json: ' + err.message);
    });
  });
};

var create_username = function(label, username, password, cb) {
  var parts;

  parts = username.split('/');
  if (parts.length < 3) return cb(new Error('invalid username'));

  bcrypt.hash(password, 10, function(err, hash) {
    var value;

    if (err) return cb(err);

    value = { username: username, authParams: { protocol: 'bcrypt', hash: hash } };
    client.set(username, JSON.stringify(value), function(err, reply) {
      var config;

      if (err) console.log('redis set error: ' + username + ': ' + err.message);
      cb(err, reply);
      if (err) return;

      config = { '_type'         : 'configuration'
               , deviceid        : ''

               , mindist         : 200
               , mintime         : 180

               , clientid        : parts.slice(1).join('/')
               , host            : parts[1] + '.' + options.namedServers
               , port            : 8883
               , tls             : true
               , auth            : true
               , user            : username
               , pass            : password

               , ab              : true
               , subscription    : parts.slice(0,2).join('/') + '/#'
               , subscriptionqos : 1

               , topic           : username
               , qos             : 1
               , retain          : true

               , clean           : false
               , keepalive       : 60

               , willtopic       : ''
               , will            : 'lwt'
               , willqos         : 1
               , willretain      : false

               , monitoring      : 2
               };

      fs.writeFile(parts.join('_') + '.mqtc', JSON.stringify(config), { mode: 0644 }, function(err) {
        if (err) console.log('file write error: ' + parts.join('_') + '.mqtc: ' + err.message);
      });
    });
  });
};
