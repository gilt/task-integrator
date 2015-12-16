console.log('Running task-integrator Mechanical Turk ping function');

var configLoader = require("./lib/dynamodb-config");
var mturk = require('mturk');

exports.ping = function(event, context) {
    configLoader.loadConfig(context.functionName + "-config", function(config) {
      var mturkClient = mturk({
        creds: {
          accessKey: config.auth.access_key,
          secretKey: config.auth.secret_key
        },
        sandbox: config.sandbox
      });
      
      mturkClient.GetAccountBalance({}, function(err, balance) {
        if (err) throw err;
        context.succeed(balance + " credits in the account");
      });
    });
};

exports.upload = function(event, context) {
  console.log("event received: ", event);
  context.succeed("done");
};