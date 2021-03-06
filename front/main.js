var judger            = require('./judger/judge');
var express           = require('express');
var session           = require('express-session');
var logger            = require('morgan');
var cookieParser      = require('cookie-parser');
var bodyParser        = require('body-parser');
var passport          = require('passport');
var localStrategy     = require('passport-local').Strategy;
var sql               = require('./sql');
var path              = require('path');
var MySQLSessionStore = require('express-mysql-session')(session);
var i18n              = require('i18n');
var fs                = require('fs-extra');
var bcrypt            = require('./bcrypt');
var app               = express();
var fileman           = require('./file-manager');
var kue               = require('kue');
var cluster           = require('cluster');
var RedisStore        = require('connect-redis')(session)
var NO_SSL            = false;
'use strict';

NO_SSL=process.argv[2]==='-nossl';

if(cluster.isMaster) {
  // Count the machine's CPUs
  var cpuCount = require('os').cpus().length;
  // Create a worker for each CPU
  for (var i=0;i<1; i++) {
      cluster.fork();
  }
} else {
  console.log('Worker %d running!', cluster.worker.id);
  // returns an instance of node-greenlock with additional helper methods
  var lex=null;
  if(!NO_SSL) {
    lex=require('greenlock-express').create({
      server: 'https://acme-v01.api.letsencrypt.org/directory',
      challenges: { 'dns-01': require('le-challenge-dns').create({debug: false }) },
      challengeType: 'dns-01',
      store: require('le-store-certbot').create({
        configDir: '/etc/letsencrypt',
        privkeyPath: ':configDir/live/:hostname/privkey.pem',
        fullchainPath: ':configDir/live/:hostname/fullchain.pem',
        certPath: ':configDir/live/:hostname/cert.pem',
        chainPath: ':configDir/live/:hostname/chain.pem',
        workDir: '/var/lib/letsencrypt',
        logsDir: '/var/log/letsencrypt',
        webrootPath: '~/letsencrypt/srv/www/:hostname/.well-known/acme-challenge',
        debug: false,
        approveDomains:approveDomains
      })
    });
  }

  function approveDomains(opts, certs, cb) {
    opts.approveDomains=[ 'mitsuha.co', 'www.mitsuha.co','was.sasa.hs.kr'];
    if (certs) {
      opts.domains = certs.altnames;
    }
    else {
      opts.email = 'studiodoth@protonmail.com';
      opts.agreeTos = true;
    }
    cb(null, { options: opts, certs: certs });
  }

  String.prototype.escapeSpecialChars = function() {
       return this.replace(/\\n/g, "\\n")
                  .replace(/\\'/g, "\\'")
                  .replace(/\\"/g, '\\"')
                  .replace(/\\&/g, "\\&")
                  .replace(/\\r/g, "\\r")
                  .replace(/\\t/g, "\\t")
                  .replace(/\\b/g, "\\b")
                  .replace(/\\f/g, "\\f");
  };
  var options = {
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'asdfasdf',
      database: 'sessions'
  };

  const cookieKey='@ruby';
  app.set('views',path.resolve(__dirname,'views'));
  app.set('view engine','ejs');
  app.use('/static',express.static('public'));
  app.use(logger('dev'));
  app.use(cookieParser());
  app.use(i18n.init);
  i18n.configure({
    locales: ['ko','en'],
    defaultLocale: 'ko',
    cookie: 'lang',
    directory: __dirname + '/locales',
    queryParameter: 'lang'
  });
  app.use(bodyParser.urlencoded({ extended: true, limit: '512mb' }));
  app.use(bodyParser.text({limit: '512mb'}));
  app.use(session({
    store: new RedisStore({
      url: 'redis://localhost:6379'
    }),
    secret: cookieKey,
    resave: true,
    saveUninitialized: false
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new localStrategy({
          usernameField: 'id',
          passwordField: 'password'
      },
    function(username, password, done) {
      sql.userLogin_Username(username, function(err,result) {
        if(err) {
          console.error(err);
          return done(null, false, { message: 'Server Error' });
        }
        if(result===null||result.length===0) {
          return done(null, false, { message: 'User not found' });
        }
        bcrypt.comparePassword(password,result[0].password,function(err, isPasswordMatch) {
          if(err) {
            console.error(err);
            return done(null, false, { message: 'Server Error' });
          }
          if(isPasswordMatch) return done(null,result);
          else return done(null, false, { message: 'Password incorrect'});
        });
      });
    }
  ));
  passport.serializeUser(function(user, done) {
    sql.userInfo_Username(user[0].id,function(err,result) {
      if(err) {
        console.error(err);
        return done(err,null);
      }
      done(null, {id: result[0].user_id, username: user[0].id,nickname: result[0].nickname, permissions: result[0].permissions});
    });
  });
  passport.deserializeUser(function(user, done) {
      done(null, user);
  });

  app.engine('html',require('ejs').renderFile);
  app.use(['/sudo', '/sudo*'],function(req,res,next) {
    if(typeof req.user==="undefined"||req.user===null||!((req.user.permissions>>2)%2)) {
      res.render('unauthorized', {
        myid: req.user
      });
    }
    else next();
  });
  app.use(['/sudo/master', '/sudo/master*'],function(req,res,next) {
    if(typeof req.user==="undefined"||req.user===null||!((req.user.permissions>>3)%2)) {
      res.render('unauthorized', {
        myid: req.user
      });
    }
    else next();
  });
  app.use('/sudo/cases/',fileman(path.resolve(__dirname,'./../cases'), {textExtensions: 'out'}));
  app.use(function(req,res,next) {
    if(req.query.hasOwnProperty('lang')) {
      res.cookie('lang', req.query.lang, { maxAge: 900000, httpOnly: true });
    }
    next();
  });

  app.use('/sudo/master/kue', kue.app);

  var router_main = require('./routes/main')(app);
  var router_user = require('./routes/user')(app);
  var router_prob = require('./routes/problems')(app);
  var router_sudo = require('./routes/sudo')(app);
  var router_sudo = require('./routes/board')(app);
  sql.getLanguages(function(err,result) {
    if(err) {
      console.error('Failed to get languages');
      console.error(err)
    }
    global.lang = {};
    for(var i=0;i<result.length;i++) {
      global.lang[result[i].codename]=result[i];
      console.log('Loaded language '+result[i].codename);
    }
  });
  if(NO_SSL) {
    app.listen(41628, function() {
      console.log('NOSSL mode, listening at port 41628')
    })
  }
  else {
    require('http').createServer(lex.middleware(require('redirect-https')({port:31628}))).listen(41628, function () {
      console.log("Listening for ACME http-01 challenges on", this.address());
    });

    require('https').createServer(lex.httpsOptions, lex.middleware(app)).listen(31628, function () {
      console.log("Listening for ACME tls-sni-01 challenges and serve app on", this.address());
    });
  }
}
