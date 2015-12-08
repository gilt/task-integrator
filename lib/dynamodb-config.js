var exports = module.exports = {};

var AWS = require("aws-sdk");
var dynamodb = new AWS.DynamoDB.DocumentClient();

exports.loadConfig = function(tableName, callback) {
  console.log("Loading config from ", tableName);
  var config = {};
  var params = { TableName: tableName };
  dynamodb.scan(params, function(err, data) {
    onScan(err, data, dynamodb, params, config, callback);
  });
  return config;
}

function onScan(err, data, dynamodb, params, config, callback) {
  if (err) {
      console.error("Unable to scan the table[", params.TableName, "]. Error JSON:", JSON.stringify(err, null, 2));
  } else {
      // Load all the config
      console.log("Scan succeeded. Loading config keys:");
      data.Items.forEach(function(kv) {
        console.log(" -", kv.key);
        config[kv.key] = kv.value;
      });

      // continue scanning if we have more config
      if (typeof data.LastEvaluatedKey != "undefined") {
          console.log("Scanning for more.");
          params.ExclusiveStartKey = data.LastEvaluatedKey;
          dynamodb.scan(params, function(err, data) {
            onScan(err, data, dynamodb, params, config, callback);
          });
      } else {
        callback(config);
      }
  }
}