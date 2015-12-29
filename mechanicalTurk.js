var async = require('async')
var AWS = require("aws-sdk");
var configLoader = require("./lib/dynamodb-config");
var mturk = require('mturk');
var csv = require('csv');
var s3 = new AWS.S3();
var sanitizeHtml = require('sanitize-html');

exports.ping = function(event, context) {
  console.log('Running task-integrator Mechanical Turk ping function');
  withConfigAndMTurkClient(context.functionName, '', function(mturkClient, config) {
    mturkClient.GetAccountBalance({}, function(err, balance) {
      withError(err, function() {
        context.succeed(balance + " credits in the account");
      });
    });
  });
};

exports.upload = function(event, context) {
  console.log('Running task-integrator Mechanical Turk upload function');

  withConfigAndMTurkClient(context.functionName, 'MTurkImporterFunction', function(mturkClient, config) {
    async.concat(
      event.Records,
      function(record, callback) {
        var objectKey = record.s3.object.key;
        var hitLayoutId = objectKey.substr(0, objectKey.indexOf('/'));
        if (hitLayoutId) {
          var baseRequest = config.layouts[hitLayoutId];
          if (baseRequest) {
            console.log("HITLayoutId: " + hitLayoutId);
            s3.getObject({
              Bucket: record.s3.bucket.name,
              Key: record.s3.object.key
            }, function(err, s3Object) {
              withError(err, function() {
                baseRequest["HITLayoutId"] = hitLayoutId;
                createHitsForCsv(s3Object.Body, baseRequest, mturkClient, callback);
              });
            });
          } else {
            callback("HitLayoutId [" + hitLayoutId + "] does not have an entry in configuration.");
          }
        } else {
          callback("Object [" + objectKey + "] does not have a HITLayoutId in its path.");
        }
      },
      function(err, hitIds) {
        withError(err, function() {
          if (hitIds.length > 0) {
            // Ensure that notifications are turned on for the HITType.
            // This will be the same for all tasks in the batch, so only
            // need to do this once.
            setupNotificationsForHit(hitIds[0], mturkClient, config.turk_notification_queue, function(err) {
              withError(err, function() {
                context.succeed(hitIds.length + " HITs created.");
              });
            });
          } else {
            console.warn("No HITs created.");
          }
        });
      }
    );
  });
}

// --- Private helper functions ---

function createHitsForCsv(csvBody, baseRequest, mturkClient, callback) {
  csv.parse(csvBody, function(err, csvDoc) {
    withError(err, function() {
      var header = csvDoc.shift();
      async.map(csvDoc, function(row, callback) {
        createHitForCsvRow(row, header, baseRequest, mturkClient, callback);
      }, function(err, hitIds) {
        withError(err, function() {
          callback(null, hitIds);
        }, callback);
      });
    });
  });
}

function createHitForCsvRow(row, header, baseRequest, mturkClient, callback) {
  var hitLayoutParameters = {};
  var request = baseRequest;
  for (var i = 0; i < header.length; i++) {
    hitLayoutParameters[header[i]] = sanitizeHtml(row[i]);
  }
  request["HITLayoutParameters"] = hitLayoutParameters;
  console.log(request);
  mturkClient.CreateHIT(request, function(err, hitId){
    withError(err, function() {
      console.log("Created HIT " + hitId);
      callback(null, hitId);
    }, callback);
  });
}

function getStackName(functionName, functionIdentifier) {
  var i = functionName.indexOf("-" + functionIdentifier);
  if (functionIdentifier && i >= 0)
    return functionName.substr(0, i);
  else
    return functionName;
}

function setupNotificationsForHit(hitId, mturkClient, destinationQueueUrl, callback) {
  mturkClient.GetHIT({ HITId: hitId }, function(err, hit) {
    withError(err, function() {
      setupNotificationsForHitType(hit.HITTypeId, mturkClient, destinationQueueUrl, callback);
    }, callback);
  });
}

function setupNotificationsForHitType(hitTypeId, mturkClient, destinationQueueUrl, callback) {
  mturkClient.SetHITTypeNotification({
    HITTypeId: hitTypeId,
    Active: true,
    Notification: {
      Destination: destinationQueueUrl,
      Transport: "SQS",
      Version: "2006-05-05",
      EventType: ["AssignmentSubmitted", ""]
    }
  }, function(err, hitId) {
    withError(err, function() {
      console.log("Set up notifications for HITTypeId " + hitTypeId);
      callback();
    }, callback);
  });
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

function withError(err, callback, errorCallback) {
  if (err) {
    if (errorCallback) {
      errorCallback(err);
    } else {
      error(err);
    }
  }
  callback();
}