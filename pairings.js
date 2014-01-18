var http      = require('http')
  , https     = require('https')
  , speakeasy = require('speakeasy')
  , params    = require('./steward').params
  , url       = require('url')
  ;


http.createServer(function(request, response) {
  var content= '';
  request.setEncoding('utf8');
  request.on('data', function(chunk) {
    content += chunk.toString();
  }).on('close', function() {
    console.log('http error: premature close');
  }).on('end', function() {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET, POST' });
      return response.end();
    }

// at present, don't care about the pathname...
    roundtrip(function(err, code, data) {
      if (!!err) {
        response.writeHead(500);
        return response.end(err.message);
      }

      response.writeHead(code);
      return response.end(data);
    });
  });
}).listen(8894, '127.0.0.1', function() {
  console.log('listening on http://127.0.0.1:8894');
});

var roundtrip = function(callback) {
  var options, u;

  u = url.parse(params.issuer);
  options = { host    : params.server.hostname
            , port    : params.server.port
            , method  : 'GET'
            , path    : '/pairings/' + params.labels[0]
            , headers : { authorization : 'TOTP '
                                        + 'username="' + params.uuid[0] + '", '
                                        + 'response="' + speakeasy.totp({ key      : params.base32
                                                                        , length   : 6
                                                                        , encoding : 'base32'
                                                                        , step     : params.step }) + '"'
                        , host          : u.hostname + ':' + params.server.port
                        }
            , agent   : false
            , ca      : [ new Buffer(params.server.ca) ]
            };
  https.request(options, function(response) {
    var content = '';
    
    response.setEncoding('utf8');
    response.on('data', function(chunk) {
      content += chunk.toString();
    }).on('end', function() {
      var data, entry, i, message;

      try {
        if (response.statusCode !== 200) throw new Error();
        message = JSON.parse(content);
        message.reverse();
      } catch(ex) { return callback(null, response.statusCode, content); }

      data = '<table><tr><td style="text-align: right;">when&nbsp;&nbsp;</td>'
               + '<td style="text-align: center;">responder</td>'
               + '<td style="text-align: center;">initiate</td>'
               + '<td>pathname</td></tr>';
      for (i = 0; i < message.length; i++) {
        entry = message[i];
        data += '<tr><td style="text-align: right;">' + time_ago(entry.timestamp, true)
                  + '&nbsp&nbsp;</td><td>' + entry.responder
                  + '&nbsp;&nbsp;</td><td>' + entry.initiator
                  + '&nbsp;&nbsp;</td><td>' + entry.pathname
                  + '</td></tr>';
      }
      data += '</table>';
      callback(null, response.statusCode, data);
    }).on('close', function() {
      callback(new Error('premature eof'));
    });
  }).on('error', function(err) {
      callback(err);
  }).end();
};

// http://stackoverflow.com/questions/3177836/how-to-format-time-since-xxx-e-g-4-minutes-ago-similar-to-stack-exchange-site
var time_ago = function(time, agoP) {
  switch (typeof time) {
    case 'number':
      break;

    case 'string':
      time = +new Date(time);
      break;

    case 'object':
      if (time.constructor === Date) time = time.getTime();
      break;

    default:
      time = +new Date();
      break;
  }
  var time_formats = [
    [         60, 's'      ,                   1], // 60
    [        120, '1m',            '1m from now'], // 60*2
    [       3600, 'm',                        60], // 60*60, 60
    [       7200, '1h',            '1h from now'], // 60*60*2
    [      86400, 'h',                      3600], // 60*60*24, 60*60
    [     172800, 'yesterday',        'tomorrow'], // 60*60*24*2
    [     604800, 'd',                     86400], // 60*60*24*7, 60*60*24
    [    1209600, 'last week',       'next week'], // 60*60*24*7*4*2
    [    2419200, 'w',                    604800], // 60*60*24*7*4, 60*60*24*7
    [    4838400, 'last month',     'next month'], // 60*60*24*7*4*2
    [   29030400, 'months',              2419200], // 60*60*24*7*4*12, 60*60*24*7*4
    [   58060800, 'last year',       'next year'], // 60*60*24*7*4*12*2
    [ 2903040000, 'years',              29030400], // 60*60*24*7*4*12*100, 60*60*24*7*4*12
    [ 5806080000, 'last century', 'next century'], // 60*60*24*7*4*12*100*2
    [58060800000, 'centuries',        2903040000]  // 60*60*24*7*4*12*100*20, 60*60*24*7*4*12*100
  ];
  var seconds = (+new Date() - time) / 1000
    , token = agoP ? 'ago' : ''
    , list_choice = 1;

  if (seconds < 0) {
    seconds = Math.abs(seconds);
    token = 'from now';
    list_choice = 2;
  } else if (seconds < 1) {
    return 'now';
  }

  var i = 0
    , format;
  while (!!(format = time_formats[i++]))
    if (seconds < format[0]) {
      if (typeof format[2] == 'string') return format[list_choice];
      return Math.floor(seconds / format[2]) + format[1] + ' ' + token;
    }
  return time;
};
