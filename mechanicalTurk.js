var Promise = require('bluebird');
var AWS = require("aws-sdk"),
    cloudwatch = Promise.promisifyAll(new AWS.CloudWatch()),
    configLoader = require("./lib/dynamodb-config"),
    csv = Promise.promisifyAll(require('csv')),
    dynamodb = Promise.promisifyAll(new AWS.DynamoDB()),
    mturk = require('mturk'),
    s3 = Promise.promisifyAll(new AWS.S3()),
    sanitizeHtml = require('sanitize-html'),
    sns = Promise.promisifyAll(new AWS.SNS()),
    sqs = Promise.promisifyAll(new AWS.SQS()),
    xml2js = Promise.promisifyAll(require('xml2js').Parser());
var snsArns = {};

exports.ping = function(event, lambdaContext) {
  console.log('Running task-integrator Mechanical Turk ping function');

  var stackName = getStackName(lambdaContext.functionName, '');
  init(stackName)
  .then(function(context) {
    context.mturkClient
    .GetAccountBalanceAsync({})
    .then(function(balance) {
      lambdaContext.succeed(balance + " credits in the account");
    })
    .catch(error);
  });
};

exports.upload = function(event, lambdaContext) {
  console.log('Running task-integrator Mechanical Turk upload function');

  var stackName = getStackName(lambdaContext.functionName, 'MTurkImporterFunction');
  init(stackName)
  .then(function(context) {
    return Promise
    .map(
      event.Records,
      function(record) {
        var objectKey = record.s3.object.key;
        var taskName = objectKey.substr(0, objectKey.indexOf('/'));
        if (taskName) {
          var baseRequest = context.config["task-stream-" + taskName];
          if (baseRequest) {
            console.log("taskName: " + taskName);
            return s3
            .getObjectAsync({
              Bucket: record.s3.bucket.name,
              Key: record.s3.object.key
            })
            .then(function(s3Object) {
              return createHitsForCsv(s3Object.Body, baseRequest, context.mturkClient, stackName, objectKey);
            })
            .then(function(hitIds) {
              return Promise
              .each(
                hitIds,
                function(hitId) {
                  return dynamodb
                  .putItemAsync({
                    TableName: stackName + "-tasks",
                    Item: {
                      task_id: {'S': hitId},
                      task_name: {'S': taskName}
                    }
                  })
                  .then(function(data) {
                    return hitId;
                  });
                }
              );
            })
            .then(function(hitIds) {
              return logMetric(stackName + '-' + taskName + '-tasks-created', hitIds.length)
              .then(function() {
                return logMetric(stackName + '-' + taskName + '-assignments-created', hitIds.length * baseRequest["MaxAssignments"])
              })
              .then(function() {
                return hitIds;
              });
            });
          } else {
            throw "Task [" + taskName + "] does not have an entry in configuration.";
          }
        } else {
          throw "Object [" + objectKey + "] does not have a taskName in its path.";
        }
      }
    )
    .then(function(recordsHITIds) {
      var hitIds = flatten(recordsHITIds);
      if (hitIds.length > 0) {
        // Ensure that notifications are turned on for the HITType.
        // This will be the same for all tasks in the batch, so only
        // need to do this once.
        return setupNotificationsForHit(hitIds[0], context.mturkClient, context.config.turk_notification_queue).then(function() {
          return hitIds;
        });
      } else {
        return hitIds;
      }
    })
    .then(function(hitIds) {
      lambdaContext.succeed("[" + hitIds.length + "] HITs created.");
    });
  })
  .catch(error);
}

exports.export = function(event, lambdaContext) {
  console.log('Running task-integrator Mechanical Turk export function');

  var stackName = getStackName(lambdaContext.functionName, 'MTurkExporterFunction');
  init(stackName)
  .then(function(context) {
    return Promise
    .map(
      "0123456789".split(""), // Iterate 10 times, because SQS does not guarantee delivery or order
      function(n) {
        return sqs
        .receiveMessageAsync({
          QueueUrl: context.config.turk_notification_queue,
          MaxNumberOfMessages: 10
        })
        .then(function(data) {
          if (data.Messages && data.Messages.length > 0) {
            return Promise
            .map(
              data.Messages,
              function(message) {
                console.log("Received Mechanical Turk notification: " + message.Body);
                return moveFromMturkToSns(JSON.parse(message.Body), stackName, context.mturkClient)
                .then(function(messageIds) {
                  return sqs
                  .deleteMessageAsync({
                    QueueUrl: context.config.turk_notification_queue,
                    ReceiptHandle: message.ReceiptHandle
                  })
                  .then(function(data) {
                    return messageIds;
                  });
                });
              }
            );
          } else {
            return [];
          }
        });
      }
    )
    .then(function(results) {
      var flattened = flatten(results);
      console.log('[' + flattened.join(',') + '] messages created');
      lambdaContext.succeed(flattened.length + ' messages pushed to SNS.');
    });
  })
  .catch(error);
}

// --- Private helper functions ---

// Returns a Promise of the array of resultant HITIds.
function createHitsForCsv(csvBody, baseRequest, mturkClient, stackName, objectKey) {
  return csv
  .parseAsync(csvBody)
  .then(function(csvDoc) {
    var header = csvDoc.shift();
    return mturkClient
    .GetAccountBalanceAsync({})
    .then(function(balance) {
      var batchCost = baseRequest.Reward.Amount * csvDoc.length;
      return logMetric(stackName + "-mechanical-turk-balance", balance)
      .then(function(data) {
        if (balance < batchCost) {
          throw 'Batch ' + objectKey + ' not processed due to insufficient funds in the account: $' + balance + ' remaining but $' + batchCost + ' required.'
        }
        return Promise.map(
          csvDoc,
          function(row) {
            var hitLayoutParameters = {};
            var request = baseRequest;
            for (var i = 0; i < header.length; i++) {
              hitLayoutParameters[header[i]] = sanitizeHtml(row[i]);
            }
            request["HITLayoutParameters"] = hitLayoutParameters;
            console.log("Creating HIT: " + JSON.stringify(request));
            return mturkClient
            .CreateHITAsync(request)
            .then(function(hitId) {
              console.log("Created HIT " + hitId);
              return hitId;
            });
          }
        );
      })
      .then(function(hitIds) {
        return logMetric(stackName + "-mechanical-turk-balance", balance - batchCost)
        .then(function(data) {
          return hitIds;
        });
      });
    })
  });
}

// Returns a Promise containing the SNS ARN for the SNS Topic for the HIT's task_name
function getSnsArn(hitId, stackName) {
  return dynamodb
  .getItemAsync({
    TableName: stackName + "-tasks",
    Key: { task_id: {'S': hitId}}
  })
  .then(function(data) {
    console.log("data: " + JSON.stringify(data));
    if (data.Item) {
      var taskName = data.Item.task_name.S;
      if (snsArns[taskName] == undefined) {
        return sns
        .createTopicAsync({ Name: stackName + "-" + taskName })
        .then(function(data) {
          snsArns[taskName] = data.TopicArn; // Save for future reference
          return data.TopicArn;
        });
      } else {
        return snsArns[taskName];
      }
    } else {
      throw "Problem finding task_name for HITId [" + hitId + "]";
    }
  });
}

// The functionIdentifier must match the section from the CloudFormation template that creates the Lambda function.
function getStackName(functionName, functionIdentifier) {
  var i = functionName.indexOf("-" + functionIdentifier);
  if (functionIdentifier && i >= 0)
    return functionName.substr(0, i);
  else
    return functionName;
}

// Returns a Promise that will perform logging for the given metric.
function logMetric(name, value) {
  console.log('Logging: ' + name + '=' + value);
  return cloudwatch.putMetricDataAsync({
    MetricData: [
      {
        MetricName: name,
        Timestamp: new Date,
        Value: value
      }
    ],
    Namespace: "task-integrator"
  })
}

// Returns a Promise containing an aray of messageIds of the resultant SNS messages.
function moveFromMturkToSns(notificationMsg, stackName, mturkClient) {
  return Promise
  .map(
    notificationMsg.Events,
    function(event) {
      return mturkClient
      .GetAssignmentAsync({ AssignmentId: event.AssignmentId })
      .then(function(assignment) {
        return getSnsArn(assignment.HITId, stackName)
        .then(function(topicArn) {
          return xml2js
          .parseStringAsync(assignment.Answer)
          .then(function(doc) {
            doc = xml2js2JSON(doc);
            message = {};
            doc.QuestionFormAnswers.Answer.forEach(function(answer) {
              // TODO: support an uploaded file here
              message[answer.QuestionIdentifier] = answer.FreeText || answer.SelectionIdentifier || answer.OtherSelectionText;
            });
            return sns
            .publishAsync({
              Message: JSON.stringify(message),
              TopicArn: topicArn
            })
            .then(function(data) {
              return logMetric(topicArn.substring(topicArn.lastIndexOf(":") + 1) + '-assignments-completed', 1)
              .then(function() {
                console.log("Sending message to SNS: " + JSON.stringify(message));
                return data.MessageId;
              })
            });
          });
        });
      });
    }
  );
}

// Returns a Promise with the given hitId
function setupNotificationsForHit(hitId, mturkClient, destinationQueueUrl) {
  return mturkClient
  .GetHITAsync({ HITId: hitId })
  .then(function(hit) {
    return mturkClient
    .SetHITTypeNotificationAsync({
      HITTypeId: hit.HITTypeId,
      Active: true,
      Notification: {
        Destination: destinationQueueUrl,
        Transport: "SQS",
        Version: "2006-05-05",
        EventType: ["AssignmentSubmitted", ""]
      }
    })
    .then(function(hitId) {
      console.log("Set up notifications for HITTypeId " + hit.HITTypeId);
      return hitId;
    });
  });
}

// Returns a Promise with a populated context object: {mtuckClient, config}
function init(stackName) {
  return configLoader
  .loadConfig(stackName + "-config")
  .then(function(config) {
    return {
      mturkClient: Promise.promisifyAll(mturk({
        creds: {
          accessKey: config.auth.access_key,
          secretKey: config.auth.secret_key
        },
        sandbox: config.sandbox
      })),
      config: config
    };
  });
}

// Converts the xml2js format (each property is an array) to a more typical
// JSON format (each property is the single value, unless the array is larger than 1 member).
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

function flatten(arrayOfArrays) {
  return [].concat.apply([], arrayOfArrays)
}
