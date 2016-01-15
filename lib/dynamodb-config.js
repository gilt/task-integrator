var exports = module.exports = {};

var Promise = require('bluebird');
var AWS = require("aws-sdk");
var dynamodb = Promise.promisifyAll(new AWS.DynamoDB.DocumentClient());

exports.loadConfig = function(tableName) {
  console.log("Loading config from ", tableName);
  return scan({ TableName: tableName }, {});
}

function scan(params, result) {
  return dynamodb
  .scanAsync(params)
  .then(function(data) {
    // Load all the config
    console.log("Scan succeeded. Loading config keys:");
    data.Items.forEach(function(kv) {
      console.log(" -", kv.key);
      result[kv.key] = kv.value;
    });

    // continue scanning if we have more config
    if (typeof data.LastEvaluatedKey != "undefined") {
        console.log("Scanning for more.");
        params.ExclusiveStartKey = data.LastEvaluatedKey;
        return scan(params, result);
    } else {
      return result;
    }
  })
  .catch(function(err) {
    throw "Unable to scan the table[" + params.TableName + "]. Error JSON: " + JSON.stringify(err, null, 2);
  });
}