TAAS-server
================
Things-as-a-service for 'hidden servers' (behind firewalls/NATs) and 'mobile clients' using a third-party service.

This package implements an HTTP-specific protocol that will allow an HTTP connection from the mobile client to the hidden
server.

## Protocol specification

The protocol:

1. The service resides at a well-known location in the Internet, e.g.,

        https://taas-registrar.example.com/

2. The hidden server establishes an HTTPS connection to the TAAS service,
and uses TOTP to authenticate itself.

        PUT /register/LABEL HTTP/1.1
        Host: taas-registrar.example.com
        Authorization: TOTP username="ID", response="TKN"

    where 'ID' is administratively assigned by the provider of the TAAS service,
and TKN is a one-time authentication token.

3. If the hidden server successfully authenticates itself using 'ID' and 'TKN',
and if the hidden server is authorized to use 'LABEL',
then the TAAS service listens on IP address 'a.b.c.d' for port 'p' and sends:

        HTTP/1.1 200 OK
        Content-Type: text/plain

        a.b.c.d:p

    and closes the connection.
(If an error occurs, the TAAS service returns a 4xx or 5xx response and closes the connection.)

    The hidden server, upon receiving the 200 response,
immediately establishes a TCP connection to IP address 'a.b.c.d' port 'p',
and waits for activity on that connection
In the interim,
if the connection fails,
the hidden server retries Step 2 accordingly.
The TAAS service will accept at most one connection to IP address 'a.b.c.d' port 'p'.

    Instead of a 200, 4xx, or 5xx code, the TAAS service might return a 3xx code.
In that case, the hidden server should process the redirect appropriately.

4. The mobile client establishes an HTTPS connection to the TAAS service, e.g.,

        https://LABEL.taas.example.com/...

5. If a hidden server with that identity is registered,
then the TAAS service listens on IP address 'a.b.c.d' for port 'q' and sends a 307 redirection:

        HTTP/1.1 307
        Location: https://a.b.c.d:q

    or

        HTTP/1.1 307
        Location: https://taas.example.com:q

    The mobile client, upon receiving the 307 response,
immediately establishes a TCP connection to IP address 'a.b.c.d' (or host 'taas.example.com') port 'q'
and then begins sending traffic.
(If an error occurs, the TAAS service returns a 4xx or 5xx response and closes the connection.)
The TAAS service will accept multiple connections to port 'q'.

6. The hidden server, in addition to processing any data on the connection,
may make additional HTTPS connections to the TAAS service (cf., Step 2).
In this fashion,
the hidden server should always have something waiting for the next mobile client connection.

7. Regardless, the TAAS service simply copies octets from one connection to the other.

Pictorially:

                                  TAAS  service
                                +----------------+
                                |                |
                                | 1:listen on    |
                                | well-known IP  |
                                | adddress and   |
     "hidden" server            | TCP port       |
     behind NAT, etc.           |                |
    +----------------+          |                |
    |                |          |                |
    |2:HTTPS PUT     |   ---->  |                |
    | /register/LABEL|          |                |
    |                |          |                |
    |                |          | 3: listen on   |
    |                |          | a.b.c.d:p      |
    |                |          |                |
    |                |  <----   | return 200     |
    |                |          |                |
    |    close HTTPS |          | close HTTPS    |
    |                |          |                |
    | TCP connect to |          |                |
    |     IP a.b.c.d |          |                |
    |     PORT p and |          |                |
    |  keep TCP open |          | keep TCP open, |
    |                |          | but refuse new |
    |                |          | connections    |            mobile  client
    |                |          |                |          +----------------+
    |                |          |                |          |                |
    |                |          |                |          | 4:HTTPS to     |
    |                |          |                |  <----   | LABEL...       |
    |                |          |                |          |                |
    |                |          | 5: listen on   |          |                |
    |                |          | a.b.c.d:q and  |          |                |
    |                |          | allow multiple |          |                |
    |                |          | connections    |          |                |
    |                |          |                |          |                |
    |                |          | return 307     |   ---->  |                |
    |                |          |                |          |                |
    |                |          | close HTTPS    |          | close HTTPS    |
    |                |          |                |          |                |
    |                |          |                |          | HTTPS to       |
    |                |          |                |  <----   | a.b.c.d:q      |
    |                |          |                |          |                |
    |                |  <----   | send traffic   |          |                |
    |                |          |                |          |                |
    |                |          |                |          |                |
    |                |          |                |          |                |
    | 6:             |          |                |          |                |
    | [if multiple   |          |                |          |                |
    |  connections   |          |                |          |                |
    |  are desired,  |          |                |          |                |
    |  another TCP   |          |                |          |                |
    |  connection to |          |                |          |                |
    |  the TAAS ser- |          |                |          |                |
    |  vice occurs]  |          |                |          |                |
    |                |          |                |          |                |
    |                |          |                |          |                |
    |       7:       |          |       7:       |          |       7:       |
    | send/recv data |  <---->  | <------------> |  <---->  | send/recv data |
    |    until close |          |                |          | until close    |
    |                |          |                |          |                |
    |                |  <----   | <------------  |  <----   | close          |
    |                |          |     and/or     |          |                |
    |          close |   ---->  |  ------------> |   ---->  |                |
    |                |          |                |          |                |
    +----------------+          +----------------+          +----------------+

Security Model
==============
The security model is:

1. The hidden server and the mobile client have to know the domain-name or IP-address of the TAAS service,
and have to trust the certificate used by the TAAS service.
This knowledge and trust is determined by out-of-band means.

2. The hidden server and TAAS service must share a time-based secret.
This is how the TAAS service knows that the hidden server is associated with a particular ID.
This shared secret is created by out-of-band means.

3. The mobile client does not need to authenticate itself to the TAAS service.
If a hidden server is responding for a particular ID,
then amy mobile client knowing the LABEL is allowed to initiate a connection to that hidden server.

4. __Most importantly:__ it is the responsibility of the hidden server to authenticate the mobile client once the rendezvous
occurs.
Although there are many well-reasoned arguments as to why hiding behind a firewall is a bad thing,
please do not negate the one good thing about being behind a firewall or NAT!

VPS Set-Up
==========
You do not need to have a domain name for your VPS;
however, you must have a stable IP address (e.g., 'a.b.c.d').

1. Get a [tarball](https://github.com/TheThingSystem/TAAS-server/archive/master.zip) of this repostory onto your local system,
extract it, and then:

        % cd TAAS-server-master
        % npm -l install

    Note that until we reach Step 7, all the commands will be run on your local system.

2. Create a file called:

        vps.js

    that looks like this:

        var fs          = require('fs')
          ;

        exports.options =
          { taasHost       : 'a.b.c.d'
          , taasPort       : 443

        //, keyData        : fs.readFileSync('./registrar.key')
        //, crtData        : fs.readFileSync('./registrar.crt')

          , redisHost      : '127.0.0.1'
          , redisPort      : 6379
          , redisAuth      : ''

          , namedRegistrar : 'taas-registrar.example.com'
          , namedServers   : 'taas.example.com'
          };

    Note that the 'keyData' and 'crtData' lines are commented out. This is very important!

3. Create a keypair for use by the TAAS service:

        % node make-cert.js

        % chmod  a-w registrar.*

        % chmod go-r registrar.key

    to create a self-signed certificate:

        registrar.crt

    and the corresponding private key:

        registrar.key

    Now uncomment the two lines in vps.js, so the file looks like this:

        var fs          = require('fs')
          ;

        exports.options =
          { taasHost       : 'a.b.c.d'
          , taasPort       : 443

          , keyData        : fs.readFileSync('./registrar.key')
          , crtData        : fs.readFileSync('./registrar.crt')

          , redisHost      : '127.0.0.1'
          , redisPort      : 6379
          , redisAuth      : ''

          , namedRegistrar : 'taas-registrar.example.com'
          , namedServers   : 'taas.example.com'
          };

4. We're nearly ready.
The next step is to create entries in the database for the hidden servers.
Running:

        % node users.js

    will bring up a server on:

        http://127.0.0.1:8893

    Browse this URL, and you will see all UUIDs (IDs) and LABELs defined in the database (initially, none).
To create an entry, use the form on the page.
Whenever an entry is created,
a JS file is created which you can use with your hidden server.
You will want to copy the JS file to the provisioning area for your hidden server.
Users of that server will then be able to access it as

        https://LABEL.taas.example.com/...


5. When you are done creating entries for the remote servers, kill the node process running

        users.js

6. Copy the server files to the VPS:

        % rm -rf node_modules
        % cd .. ; scp -r TAAS-server-master root@a.b.c.d:.

7. Login to the VPS and install [node.js](http://nodejs.org/download/), and then

        vps% cd TAAS-server-master/
        vps% npm install -l
        vps% cp vps.js local.js

8. Now update the DNS, by adding these two RRs

        taas-registrar.example.com. IN A a.b.c.d
        *.taas.example.com. IN A a.b.c.d

9. Finally, start the server:

        vps% bin/run.sh

    Log entries are written to the file:

        server.log

License
=======

[MIT](http://en.wikipedia.org/wiki/MIT_License) license. Freely have you received, freely give.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
