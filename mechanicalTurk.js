console.log('Running task-integrator Mechanical Turk ping function');

var AWS = require("aws-sdk");
var configLoader = require("./lib/dynamodb-config");
var mturk = require('mturk');
var csv = require('csv');
var s3 = new AWS.S3();
var sanitizeHtml = require('sanitize-html');

exports.ping = function(event, context) {
  withConfigAndMTurkClient(context.functionName, '', function(mturkClient, config) {
    mturkClient.GetAccountBalance({}, function(err, balance) {
      withError(err, function() {
        context.succeed(balance + " credits in the account");
      });
    });
  });
};

exports.upload = function(event, context) {
  console.log("event received: ", JSON.stringify(event));
  var numProcessed = 0;
  withConfigAndMTurkClient(context.functionName, 'MTurkImporterFunction', function(mturkClient, config) {
    event.Records.forEach(function(record) {
      var objectKey = record.s3.object.key;
      var hitLayoutId = objectKey.substr(0, objectKey.indexOf('/'));
      if (hitLayoutId) {
        var request = config.layouts[hitLayoutId];
        if (request) {
          request["HITLayoutId"] = hitLayoutId;
          console.log("HITLayoutId: " + hitLayoutId);
          s3.getObject({
            Bucket: record.s3.bucket.name,
            Key: record.s3.object.key
          }, function(err, s3Object) {
            withError(err, function() {
              console.log("s3Object: " + s3Object.Body);
              csv.parse(s3Object.Body, function(err, csvDoc) {
                withError(err, function() {
                  var header = csvDoc.shift();
                  csvDoc.forEach(function(row) {
                    var hitLayoutParameters = {};
                    for (var i = 0; i < header.length; i++) {
                      hitLayoutParameters[header[i]] = sanitizeHtml(row[i]);
                    }
                    request["HITLayoutParameters"] = hitLayoutParameters;
                    console.log(request);
                    mturkClient.CreateHIT(request, function(err, hitId){
                      withError(err, function() {
                        console.log("Created HIT " + hitId);
                        if (numProcessed == 0) {
                          // Ensure that notifications are turned on for the HITType.
                          // This be the same for all tasks in the batch, so only need
                          // to do this once.
                          mturkClient.GetHIT({HITId: hitId}, function(err, hit) {
                            withError(err, function() {
                              mturkClient.SetHITTypeNotification({
                                HITTypeId: hit.HITTypeId,
                                Active: true,
                                Notification: {
                                  Destination: config.turk_notification_queue,
                                  Transport: "SQS",
                                  Version: "2006-05-05",
                                  EventType: ["AssignmentSubmitted", ""]
                                }
                              }, function(err, hitId) {
                                withError(err, function() {
                                  console.log("Set up notifications for HITTypeId " + hit.HITTypeId)
                                });
                              });
                            });
                          });
                        }
                        numProcessed++;
                      });
                    });
                  });
                });
              });
            });
          });
        } else {
          error("HitLayoutId [" + hitLayoutId + "] does not have an entry in configuration.")
        }
      } else {
        error("Object [" + objectKey + "] does not have a HITLayoutId in its path.");
      }
    });
    console.log(numProcessed + " HITs created.");
    // context.succeed(numProcessed + " HITs created.");
  });
};

function getStackName(functionName, functionIdentifier) {
  var i = functionName.indexOf("-" + functionIdentifier);
  if (functionIdentifier && i >= 0)
    return functionName.substr(0, i);
  else
    return functionName;
}

// The functionIdentifier must match the section from the CloudFormation template that creates the Lambda function.
function withConfigAndMTurkClient(functionName, functionIdentifier, callback) {
  configLoader.loadConfig(getStackName(functionName, functionIdentifier) + "-config", function(config) {
    var mturkClient = mturk({
      creds: {
        accessKey: config.auth.access_key,
        secretKey: config.auth.secret_key
      },
      sandbox: config.sandbox
    });
    callback(mturkClient, config);
  });
}

function error(err) {
  console.error("Error:", err, err.stack);
  throw err;
}

function withError(err, callback) {
  if (err) {
    error(err);
  }
  callback();
}