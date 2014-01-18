var bcrypt    = require('bcrypt')
  , minimatch = require('minimatch')
  , mqtt      = require('mqtt')
  , redis     = require('redis')
  , speakeasy = require('speakeasy')
  , winston   = require('winston')
  , options   = require('./local').options
  ;


options.logger = new (winston.Logger)({ transports : [ new (winston.transports.Console)({ level    : 'error'      })
                                                     , new (winston.transports.File)   ({ filename : 'broker.log' })
                                                     ]
                                      });
options.logger.setLevels(winston.config.syslog.levels);


if (options.redisHost === '127.0.0.1') {
  require('nedis').createServer({ server: options.redisHost, port: options.redisPort }).on('error', function(err) {
    if (!err) return options.logger.info('REDIS listening on tcp://' +  options.redisHost + ':' + options.redisPort);

  if ((err.code === 'EADDRINUSE') && (err.syscall === 'listen')) return;
  options.logger.alert('nedis err: ' + err.message);
  process.exit(1);
  }).listen(options.redisPort, options.redisHost);
}


var startP = false;
var client = redis.createClient(options.redisPort, options.redisHost, { parser: 'javascript' });
client.auth(options.redisAuth, function(err) {
  if (err) throw err;
});
client.on('ready', function() {
  var server;

  if (startP) return;
  startP = true;

  options.logger.info('redis started');

  server = (!!options.keyPath) ? mqtt.createSecureServer(options.keyPath, options.crtPath, listener)
                               : mqtt.createServer(listener);

  server.on('error', function(err) {
    options.logger.error('server', { event: 'error', diagnostic: err.message });
  }).listen(options.mqttPort, function() {
    options.logger.info('MQTT broker listening on mqtts://*:' + this.address().port);
  });
}).on('connect',  function() {
}).on('error',  function(err) {
  options.logger.error('redis error: ' + err.message);
  throw err;
}).on('end',  function() {
});


var listener = function(client) {
  var self = this;

  var clientId;

  if (!self.clients) self.clients = {};

  if (!self.publications) self.publications = {};

  if (!self.timer1) {
    self.timer1 = setInterval(function() {
      var id, now;

      now = new Date().getTime();
      for (id in self.clients) {
        if ((!self.clients.hasOwnProperty(id)) || (self.clients[id].nextping >= now) || (!self.clients[id].client)) continue;

        options.logger.warning('client', properties(self, id, { event: 'timeout' }));
        closer(self, self.clients[id].client);
        break;
      }
    }, 1 * 1000);
  }

  if (!self.timer2) {
    self.timer2 = setInterval(function() {
      var i, messages, timestamp, topic;

      timestamp = new Date().getTime() - (86400 * 1000);
      for (topic in self.publications) {
        if (!self.publications.hasOwnProperty(topic)) continue;

        messages = self.publications[topic].messages;
        if (!messages) continue;

        for (i = messages.length - 1; i >= 0; i--) if (messages[i].timestamp < timestamp) break;
        if (i >= 0) messages.splice(0, i + 1);

        i = messages.length;
        options.logger.debug('publications',
                          { topic : topic
                          , count : messages.length
                          , min   : (i > 0) ? messages[    0].timestamp : null
                          , max   : (i > 0) ? messages[i - 1].timestamp : null
                          });
      }
    }, 86400 * 1000);
  }

  client.on('connect', function(packet) {
    var hcfP, lwt, password, username;

    var fail = function(returnCode) {
      options.logger.warning('client', properties(self, clientId, { event: 'connect', returnCode: returnCode }));
      try { client.connack({ returnCode: returnCode }); } catch(ex) {}
      return closer(self, client);
    };

    clientId = packet.clientId;
    password = packet.password;
    if (!!password) packet.password = '...';
    options.logger.info('client', properties(self, clientId, { event: 'connect', packet: packet }));

    if (packet.protocolVersion !== 3) return fail(1);
    if (packet.protocolId !== 'MQIsdp') return fail(2);
    if ((!packet.clientId) || (packet.clientId.length > 23)) return fail(2);
    username = normalize(packet.username);
    if ((!username) || (username.indexOf('#') !== -1) || (username.indexOf('+') !== -1) || (username.indexOf('*') !== -1)) {
      return fail(4);
    }
    if ((!password) || (!password.length)) return fail(4);

    authenticate(packet, packet.username, password, function(err, result) {
      if (!!err) {
        options.logger.info('client', properties(self, clientId, { event: 'authenticate', diagnostic: err.message }));
        return fail(5);
      }

      if (!!self.clients[clientId]) {
        hcfP = self.clients[clientId].client === client;
        closer(self, self.clients[clientId]);
        if (hcfP) return;

        if (packet.clean) self.clients[clientId].subscriptions = {};
      } else self.clients[clientId] = { clientId: clientId, subscriptions: {} };

      self.clients[clientId].clean = packet.clean;
      if (!!packet.will) {
        lwt = { topic: normalize(packet.will.topic), payload: packet.will.payload, retain : packet.will.retain };
        if (publishP(self, self.clients[clientId], lwt.topic)) self.clients[clientId].lwt = lwt;
      }
      self.clients[clientId].username = packet.username;
      self.clients[clientId].keepalive = packet.keepalive * 1500;
      self.clients[clientId].nextping = new Date().getTime() + self.clients[clientId].keepalive;
      self.clients[clientId].permissions = result;
      self.clients[clientId].client = client;

      try { client.connack({ returnCode: 0 }); } catch(ex) { return closer(self, client); }

      sync(self, clientId, null);
    });
  }).on('publish', function(packet) {
    var message, topic;

    options.logger.info('client', properties(self, clientId, { event: 'publish', packet: packet }));
    if (!clientId) return closer(self, client);

    if (packet.qos === 1) client.puback({ messageId: packet.messageId });

    topic = normalize(packet.topic);
    if (!publishP(self, self.clients[clientId], topic)) return;

    message = { messageId: packet.messageId, payload: packet.payload, timestamp: new Date().getTime() };
    sync(self, null, topic, message);
    if (!packet.retain) return;

    if (!self.publications[topic]) self.publications[topic] = { messages: [] };
    self.publications[topic].messages.push(message);
  }).on('puback', function(packet) {
    options.logger.info('client', properties(self, clientId, { event: 'puback', packet: packet }));
    if (!clientId) return closer(self, client);
  }).on('subscribe', function(packet) {
    var granted, grantP, i, pattern, patterns, qos;

    options.logger.info('client', properties(self, clientId, { event: 'subscribe', packet: packet }));
    if (!clientId) return closer(self, client);

    granted = [];
    patterns = [];
    for (i = 0; i < packet.subscriptions.length; i++) {
      pattern = normalize(packet.subscriptions[i].topic);
      if (!pattern) pattern = '#';
      grantP = subscribeP(self, self.clients[clientId], pattern);
      qos = grantP && (packet.subscriptions[i].qos !== 0) ? 1 : 0;
      granted.push(qos);
      if (grantP) {
        self.clients[clientId].subscriptions[pattern] = { qos: qos, timestamp: 0 };
        patterns.push(pattern);
      }
    }
    client.suback({ granted: granted, messageId: packet.messageId });

    for (i = 0; i < patterns.length; i++) sync(self, clientId, patterns[i]);

    options.logger.debug('client', properties(self, clientId,
                                              { event: 'subscriptions', subscriptions: self.clients[clientId].subscriptions }));
  }).on('unsubscribe', function(packet) {
    options.logger.info('client', properties(self, clientId, { event: 'unsubscribe', packet: packet }));
    if (!clientId) return closer(self, client);

    delete(self.clients[clientId].subscriptions[normalize(packet.topic)]);
    client.unsuback({ messageId: packet.messageId });

    options.logger.debug('client', properties(self, clientId,
                                              { event: 'subscriptions', subscriptions: self.clients[clientId].subscriptions }));
  }).on('pingreq', function(packet) {
    options.logger.debug('client', properties(self, clientId, { event: 'pingreq', packet: packet }));

    if (!!self.clients[clientId]) self.clients[clientId].nextping = new Date().getTime() + self.clients[clientId].keepalive;

    client.pingresp();
  }).on('disconnect', function(packet) {
    options.logger.info('client', properties(self, clientId, { event: 'disconnect', packet: packet }));
    closer(self, client);
  }).on('close', function(errP) {
    var logf, lwt, message, status;

    if (errP) {
      logf = options.logger.error; status = 'error';
    } else {
      logf = options.logger.info; status = 'normal';
    }
    logf('client', properties(self, clientId, { event  : 'close'
                                              , status : status
                                              , clean  : (!!self.clients[clientId]) && self.clients[clientId].clean
                                              }));

    if (!!self.clients[clientId]) {
      delete(self.clients[clientId].client);

      if (!!self.clients[clientId].lwt) {
        lwt = self.clients[clientId].lwt;
        message = { payload: lwt.payload, timestamp: new Date().getTime() };
        sync(self, null, lwt.topic, message);

        if (lwt.retain) {
          if (!self.publications[lwt.topic]) self.publications[lwt.topic] = { messages: [] };
          self.publications[lwt.topic].messages.push(message);
        }
      }

      if (self.clients[clientId].clean) delete(self.clients[clientId]);
    }
  }).on('error', function(err) {
    options.logger.error('client', properties(self, clientId, { event: 'error', diagnostic: err.message }));
    closer(self, client);
  });
};


var authenticate = function(packet, username, password, cb) {
  client.get(packet.username, function(err, reply) {
    var branch, entry, i, now, otparams, parts, permissions;

    if (err) return cb(err);
    if (reply === null) return cb(new Error('no such entry'));

    try { entry = JSON.parse(reply); } catch(ex) { return cb(ex); }

    if (username === entry.uuid) username = 'taas/' + entry.labels[0] + '/steward';

    parts = username.split('/');
    if (parts.length < 3) return cb(new Error('invalid username'));
    branch = parts.slice(1).join('/');
    permissions = { publish   : [ username, '*/' + branch, '*/' + branch + '/#' ]
                  , subscribe : [ username, username + '/#'                     ]
                  };
    for (i = 2; i < parts.length; i++) permissions.subscribe.push(parts.slice(0, i).join('/') + '/#');
    if (!!entry.uuid) {
      permissions.publish.push('+/' + parts[1] + '/#');
      permissions.subscribe.push('+/' + parts[1] + '/#');
    }
    if (packet.clientId !== branch) return cb(new Error('clientId must match branch'));

    if (entry.authParams.protocol === 'bcrypt') {
      return bcrypt.compare(password, entry.authParams.hash, function(err, result) {
        if (!!err) return cb(err);
        if (!result) return cb(new Error('authentication mismatch'));

        return cb(null, permissions);
      });
    }

    if (entry.authParams.protocol !== 'totp') {
      return cb(new Error('unknown authentication protocol: ' + entry.authParams.protocol));
    }
    if (password.length < 6) return cb(new Error('response too short'));

// compare against previous, current, and next key to avoid worrying about clock synchornization...
    now = [ parseInt(Date.now() / 1000, 10) ];
    now.push(now[0] - 30);
    now.push(now[0] + 30);
    otparams = { key      : entry.authParams.base32
               , length   : password.length
               , encoding : 'base32'
               , step     : entry.authParams.step
               };
    for (i = 0; i < now.length; i++) {
      otparams.time = now[i];
      if (speakeasy.totp(otparams) === password.toString()) return cb(null, permissions);
    }
    cb(new Error('authentication mismatch'));
  });
};

var closer = function(self, client) {
  try { client.stream.destroy(); } catch(ex) { return options.logger.debug('client', { event: 'closer', status: 'err' }); }
  options.logger.debug('client', { event: 'closer', status: 'ok' });
};

var matchP = function(topic, pattern) {
  var i, parts;

  parts = pattern.split('/');
  for (i = 0; i < parts.length; i++) {
         if (parts[i] === '#') parts[i] = '**';
    else if (parts[i] === '+') parts[i] = '*';
  }
  pattern = parts.join('/');
  if (pattern.indexOf('*') === -1) return (topic === pattern);

  return minimatch(topic, pattern);
};

var normalize = function(s) {
  var result;

  if (!s) return null;
  result = s.replace(/(([^/])\/+$)|(([^/]))|(\/+(\/))/g, '$2$4$6');
  return ((result.length > 0) ? result : null);
};

var publishP = function(self, client, topic) {
  var i, publish;

  if ((!topic) || (topic.indexOf('#') !== -1) || (topic.indexOf('+') !== -1) || (topic.indexOf('*') !== -1)) return false;

  if ((!client.permissions) || (!client.permissions.publish)) return true;
  publish = client.permissions.publish;
  for (i = 0; i < publish.length; i++) if (matchP(topic, publish[i])) return true;

  options.logger.warning('client', properties(self, client.clientId,
                                              { event: 'publish', topic: topic, diagnostic: 'no match' }));
  return false;
};

var properties = function(self, id, params) {
  var k, props;

  props = { id: id };
  if (!!self.clients[id]) props.username = self.clients[id].username;
  if (!!params) for (k in params) if (params.hasOwnProperty(k)) props[k] = params[k];

  return props;
};

var subscribeP = function(self, client, pattern) {
  var i, subscribe;

  if (pattern.indexOf('*') !== -1) return false;

  if ((!client.permissions) || (!client.permissions.subscribe)) return true;
  subscribe = client.permissions.subscribe;
  for (i = 0; i < subscribe.length; i++) if (pattern === subscribe[i]) return true;

  options.logger.warning('client', properties(self, client.clientId,
                                              { event: 'subscribe', pattern: pattern, diagnostic: 'no match' }));
  return false;
};

var sync = function(self, clientId, pattern, message) {
  var client, i, j, messages, now, timestamp, topic;

  if (!clientId) {
    for (clientId in self.clients) if (self.clients.hasOwnProperty(clientId)) sync(self, clientId, pattern, message);

    return;
  }
  client = self.clients[clientId];
  if (!client.client) return;

  if (!pattern) {
    for (pattern in client.subscriptions) {
      if (client.subscriptions.hasOwnProperty(pattern)) sync(self, clientId, pattern, message);
    }

    return;
  }

  if (!!message) {
    topic = pattern;

    for (pattern in client.subscriptions) {
      if ((!client.subscriptions.hasOwnProperty(pattern)) || (!matchP(topic, pattern))) continue;

      options.logger.debug('client', properties(self, clientId, { event     : 'send'
                                                                , topic     : topic
                                                                , messageId : message.messageId
                                                                , octets    : message.payload.length
                                                                }));
      client.client.publish({ topic: topic, messageId: message.messageId, payload: message.payload });
    }

    return;
  }

  now = new Date().getTime();
  for (topic in self.publications) {
    if ((!self.publications.hasOwnProperty(topic)) || (!matchP(topic, pattern))) continue;

    messages = self.publications[topic].messages;
    if (!messages) continue;

    timestamp = client.subscriptions[pattern].timestamp;
    for (i = j = 0; i < messages.length; i++) {
      if (messages[i].timestamp < timestamp) continue;
      message = messages[i];

      options.logger.debug('client', properties(self, clientId, { event     : 'send'
                                                                , topic     : topic
                                                                , messageId : message.messageId
                                                                , octets    : message.payload.length
                                                                }));
      client.client.publish({ topic: topic, messageId: message.messageId, payload: message.payload });
      j++;
    }
    if (j > 0) options.logger.debug('client', properties(self, clientId, { event: 'sync', topic: topic, count: j }));
    client.subscriptions[pattern].timestamp = now;
  }
};
