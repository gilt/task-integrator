var async = require('async'),
    AWS = require("aws-sdk"),
    configLoader = require("./lib/dynamodb-config"),
    csv = require('csv'),
    mturk = require('mturk'),
    s3 = new AWS.S3(),
    sanitizeHtml = require('sanitize-html'),
    sns = new AWS.SNS(),
    sqs = new AWS.SQS(),
    xml2js = require('xml2js').Parser();
var snsArns = {};

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

  var stackName = getStackName(context.functionName, 'MTurkImporterFunction');
  withConfigAndMTurkClient(stackName, function(mturkClient, config) {
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

exports.export = function(event, context) {
  console.log('Running task-integrator Mechanical Turk export function');

  var stackName = getStackName(context.functionName, 'MTurkExporterFunction');
  withConfigAndMTurkClient(stackName, function(mturkClient, config) {
    async.times(10, function(n, next) {
      sqs.receiveMessage({
        QueueUrl: config.turk_notification_queue,
        MaxNumberOfMessages: 10
      }, function(err, data) {
        withError(err, function() {
          async.concat(data.Messages, function(message, callback) {
            console.log("Received Mechanical Turk notification: " + message.Body);
            moveFromMturkToSns(JSON.parse(message.Body), stackName, mturkClient, function(err, results) {
              withError(err, function() {
                sqs.deleteMessage({
                  QueueUrl: config.turk_notification_queue,
                  ReceiptHandle: message.ReceiptHandle
                }, function(err, data) {
                  withError(err, function() {
                    callback(null, results);
                  }, callback);
                });
              });
            });
          }, function(err, results) {
            withError(err, function() {
              next(null, results);
            }, next);
          });
        });
      });
    }, function(err, results) {
      var flattened = [].concat.apply([], results);
      console.log('[' + flattened.join(',') + '] messages created');
      context.succeed(flattened.length + ' messages pushed to SNS.');
    });
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

function withSnsArnFromHitId(hitId, stackName, mturkClient, callback) {
  mturkClient.GetHIT({ HITId: hitId }, function(err, hit) {
    withError(err, function() {
      if (snsArns[hit.HITLayoutId] == undefined) {
        sns.createTopic({ Name: stackName + "-" + hit.HITLayoutId }, function(err, data) {
          withError(err, function() {
            snsArns[hit.HITLayoutId] = data.TopicArn;
            callback(null, data.TopicArn);
          }, callback);
        });
      } else {
        callback(null, snsArns[hit.HITLayoutId]);
      }
    }, callback);
  })
}

// The functionIdentifier must match the section from the CloudFormation template that creates the Lambda function.
function getStackName(functionName, functionIdentifier) {
  var i = functionName.indexOf("-" + functionIdentifier);
  if (functionIdentifier && i >= 0)
    return functionName.substr(0, i);
  else
    return functionName;
}

function moveFromMturkToSns(notificationMsg, stackName, mturkClient, callback) {
  async.map(
    notificationMsg.Events,
    function(event, callback) {
      mturkClient.GetAssignment({ AssignmentId: event.AssignmentId }, function(err, assignment) {
        withError(err, function() {
          withSnsArnFromHitId(assignment.HITId, stackName, mturkClient, function(err, topicArn) {
            xml2js.parseString(assignment.Answer, function(err, doc) {
              withError(err, function() {
                doc = xml2js2JSON(doc);
                message = {};
                doc.QuestionFormAnswers.Answer.forEach(function(answer) {
                  // TODO: support an uploaded file here
                  message[answer.QuestionIdentifier] = answer.FreeText || answer.SelectionIdentifier || answer.OtherSelectionText;
                });
                sns.publish({
                  Message: JSON.stringify(message),
                  TopicArn: topicArn
                }, function(err, data) {
                  withError(err, function() {
                    console.log("Sending message to SNS: " + JSON.stringify(message));
                    callback(null, data.MessageId);
                  }, callback);
                });
              }, callback);
            });
          });
        }, callback);
      });
    },
    function(err, results) {
      withError(err, function() {
        callback(null, results);
      });
    }
  );
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

function withConfigAndMTurkClient(stackName, callback) {
  configLoader.loadConfig(stackName + "-config", function(config) {
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

function xml2js2JSON(elem) {
  if (typeof elem === 'string' || elem instanceof String) {
    return elem;
  } else if (elem && elem.length && elem.length <= 1) {
    return xml2js2JSON(elem[0]);
  } else if (elem && elem.length) {
    var converted = [];
    for (var i = 0; i < elem.length; i++) {
      converted.push(xml2js2JSON(elem[i]));
    };
    return converted;
  } else {
    var converted = {};
    Object.getOwnPropertyNames(elem).forEach(function(key) {
      converted[key] = xml2js2JSON(elem[key]);
    });
    return converted;
  }
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