var redis     = require('redis')
  , speakeasy = require('speakeasy')
  , winston   = require('winston')
  , options   = require('./local').options
  , vous      = require('./taas')
  ;


if (options.redisHost === '127.0.0.1') {
  require('nedis').createServer({ server: options.redisHost, port: options.redisPort }).listen(options.redisPort);
}


options.logger = new (winston.Logger)({ transports : [ new (winston.transports.Console)({ level    : 'error'      })
                                                     , new (winston.transports.File)   ({ filename : 'server.log' })
                                                     ]
                                      });
options.logger.setLevels(winston.config.syslog.levels);


var startP = false;
var client = redis.createClient(options.redisPort, options.redisHost, { parser: 'javascript' });
client.auth(options.redisAuth, function(err) {
  if (err) throw err;
});
client.on('ready', function() {
  if (startP) return;
  startP = true;

  options.logger.info('redis started');

  vous.listen(options);
}).on('connect',  function() {
}).on('error',  function(err) {
  options.logger.error('redis error: ' + err.message);
  throw err;
}).on('end',  function() {
});


options.lookup = function(options, params, cb) {
  if (params.response.length < 6) return cb(new Error('response too short'));

  client.get(params.username, function(err, reply) {
    var entry, i, now, otparams;

    if (err) return cb(err);
    if (reply === null) return cb(new Error('no such entry'));

    try { entry = JSON.parse(reply); } catch(ex) { return cb(ex); }

// compare against previous, current, and next key to avoid worrying about clock synchornization...
    now = [ parseInt(Date.now() / 1000, 10) ];
    now.push(now[0] - 30);
    now.push(now[0] + 30);
    otparams = { key      : entry.authParams.base32
               , length   : params.response.length
               , encoding : 'base32'
               , step     : entry.authParams.step
               };
    for (i = 0; i < now.length; i++) {
      otparams.time = now[i];
      if (speakeasy.totp(otparams) === params.response.toString()) return cb(null, entry.labels);
    }
    cb(new Error('authentication mismatch'));
  });
};
