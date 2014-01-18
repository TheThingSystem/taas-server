var http      = require('http')
  , https     = require('https')
  , url       = require('url')
  , options   = require('./local').options
  ;


if (!options.logger) {
  options.logger =
    { error   : function(msg, props) { console.log(msg); if (!!props) console.trace(props.exception); }
    , warning : function(msg, props) { console.log(msg); if (!!props) console.log(props);             }
    , notice  : function(msg, props) { console.log(msg); if (!!props) console.log(props);             }
    , info    : function(msg, props) { console.log(msg); if (!!props) console.log(props);             }
    , debug   : function(msg, props) { console.log(msg); if (!!props) console.log(props);             }
    };
}

var start = function(host, port) {
  var client, params;

  params = { host    : host
           , port    : port
           , method  : 'GET'
           , path    : '/'
           , headers : { host: 'example.' + options.namedServers }
           , agent   : false
           };

  if (!options.crtData) client = http;
  else {
    client = https;
    params.ca = [ options.crtData ];
  }

  client.request(params, function(response) {
    var u;

    console.log(response.statusCode); console.log(response.headers);
    if (response.statusCode === 307) {
      u = url.parse(response.headers.location);
console.log(u);
      return start(u.hostname, u.port);
    }
    response.on('data', function(data) {
      options.logger.debug(data.toString());
    }).on('end', function() {
    }).on('close', function() {
      options.logger.error('response premature eof');
    }).on('error', function(err) {
      options.logger.error('response error: ' + err.message);
    });
  }).on('error', function(err) {
    options.logger.error('connect error: ' + err.message);
  }).end();
};

start(options.taasHost, options.taasPort);
