'use strict';

const express = require('express');
const noptify = require('noptify');
const chalk = require('chalk');
const http = require('http');
const qs = require('querystring');
const url = require('url');
const pathModule = require('path');
const WebMentionTemplates = require('./webmentiontemplates');

const app = express();

let count;
let fails;
let pingCount = 0;
let templateCollection;
let templates;
let templateFetchesLeft = {};
let options;

// Helper functions

const objectEmpty = function (obj) {
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      return false;
    }
  }
  return true;
};

const getURL = function (query) {
  return 'http://' + host + ':' + port + '/template?' + qs.stringify(query);
};

// Module setup

const request = require('request').defaults({
  jar: false,
  timeout: 20000,
  maxRedirects: 9,
  headers: {
    'User-Agent': 'WebMention-Testsuite (https://github.com/voxpelli/node-webmention-testpinger)'
  }
});

// General express setup

app
  .set('strict routing', true)
  .set('case sensitive routing', true);

// Add routes

app.get('/template', function (req, res) {
  const name = (req.query.name || '').replace('.', '-');
  const target = req.query.target;

  if (!name || !target) {
    console.error('Invalid mention request, missing mention name or target');
    res.send(404);
    return;
  }

  templateCollection.getTemplate(name, target, {
    alternateTarget: req.query.alternateTarget,
    commentUrl: getURL({
      name: 'basic-reply',
      target: getURL({
        name: name,
        target: target
      })
    })
  })
    .then(function (template) {
      if (!options.sync && options.fetches && !templateFetchesLeft[name]) {
        console.error('Tried to fetch mention', chalk.red.bold(name), 'too many times.');
        res.send(500);
        return;
      }

      console.log(chalk.dim('At ' + (new Date()).toTimeString()), chalk.blue.bold(name), 'was fetched.');
      res.send(template);

      if (!options.sync && options.fetches) {
        templateFetchesLeft[name] -= 1;

        if (templateFetchesLeft[name] === 0) {
          delete templateFetchesLeft[name];

          if (objectEmpty(templateFetchesLeft)) {
            console.log(chalk.green('Done with all ' + count + ' pings!'), count * options.fetches, 'fetches has been done.', fails ? chalk.red(fails + ' of them failed.') : '');
            server.close();
          }
        }
      }

      if (!templates.length && !options.sync) {
        console.log(chalk.green('Done with all ' + count + ' pings!'), fails ? chalk.red(fails + ' of them failed.') : '');
        server.close();
      }
    })
    .then(undefined, function () {
      console.error('Invalid mention', chalk.blue.bold(name), 'was requested');
      res.send(404);
    });
});

// Start server

options = noptify(process.argv, { program: 'webmention-testpinger' })
  .version(require('../package.json').version)
  .option('endpoint', '-e', 'The URL of the WebMention endpoint that will receive the pings', url)
  .option('target', '-t', 'The URL of the target that will get mentioned', [url, Array])
  .option('fetches', '-f', 'After how many fetches of each mention the server should shut down. 0 means it will never shut down. Defaults to 1.', Number)
  .option('host', '-h', 'The host name or IP-address to bring up the server at. Defaults to 127.0.0.1.', String)
  .option('port', '-p', 'The port number to bring up the server at. Defaults to 8080.', Number)
  .option('sync', '-s', 'Keeps the server running until all ping requests has gotten responses. Ignores the --fetches option.', Boolean)
  .parse();

if (!options.endpoint || !options.target) {
  console.error(chalk.red('No endpoint URL and/or no target URL to ping was provided – both required'));
  process.exit(1);
}

const port = options.port || 8080;
const host = options.host || '127.0.0.1';

const server = http.createServer(app);
server.listen(port);

if (options.fetches === undefined) {
  options.fetches = 1;
}

options.target = options.target.slice(-2);

templateCollection = new WebMentionTemplates({
  templatePath: pathModule.join(__dirname, '../templates')
});

templateCollection.getTemplateNames().catch(() => {
  console.error("Couldn't list test templates");
  process.exit(1);
}).then(function (templateNames) {
  templates = templateNames;

  count = templates.length;
  fails = 0;

  console.log('Pinging', count, 'pages targeting', options.target.join(' + '), 'to', options.endpoint);

  templates.forEach(function (file) {
    templateFetchesLeft[file] = options.fetches * options.target.length;

    if (file === 'basic-reply') {
      templateFetchesLeft[file] += 1;
    }

    let source;
    const query = {
      name: file,
      target: options.target[0]
    };

    if (options.target[1]) {
      query.alternateTarget = options.target[1];
    }

    source = getURL(query);

    options.target.forEach(function (target) {
      request({
        url: options.endpoint,
        method: 'POST',
        form: {
          source: source,
          target: target
        }
      }, function (error, response) {
        pingCount += 1;

        if (!error && response.statusCode > 199 && response.statusCode < 300) {
          console.log(chalk.dim('At ' + (new Date()).toTimeString()), chalk.green.bold(file), 'pinged.');
        } else {
          console.error(
            chalk.dim('At ' + (new Date()).toTimeString()),
            chalk.red.bold(file),
            'failed to be pinged.',
            !response ? chalk.dim('No HTTP response') : chalk.dim(
              'HTTP code ' + response.statusCode +
              (response.headers['retry-after'] ? ' – should retry after ' + parseInt(response.headers['retry-after'], 10) + ' seconds' : '')
            )
          );

          fails += 1;
          delete templateFetchesLeft[file];

          if (!options.sync && objectEmpty(templateFetchesLeft)) {
            console.log(chalk.green('Done with all ' + count + ' pings!'), fails ? chalk.red(fails + ' of them failed.') : '');
            server.close();
          }
        }

        if (options.sync && pingCount === count) {
          server.close();
        }
      });
    });
  });
}).catch(() => {
  console.error('Encountered an error during pinging');
  process.exit(1);
});
