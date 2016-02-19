# task-integrator
Provides a common way to programmatically integrate human tasks through AWS.

More specifically, this fills the gaps in functionality between Amazon Mechanical Turk and typical
AWS messaging: it supports Amazon Mechanical Turk inputs through S3 and outputs to SNS.


## Motivation
Amazon Mechanical Turk is an older technology in AWS and doesn't have full integration with standard
AWS services that are commonly used to communicate messages. This project strives to fill the gaps
in what Amazon provides, in addition to providing a common flow for non-Amazon players in this space.
The basic idea is to be able to upload tasks as a CSV to S3, and receive task results via SNS.


## Common flow
This project establishes a common flow to get human tasks into an external system (Amazon Mechanical
Turk, Wise, etc) and get the task results out of it. The assumption is that the format of the task
has been previously set up (in Mechanical Turk terminology, the HITLayout exists).

The task flow starts with a S3 bucket to which you will upload task CSVs. An AWS Lambda function will
watch that bucket and push the CSV into the external task service as tasks to be completed. Once the
humans complete the task, a second Lambda function will be notified (either via SQS or AWS API Gateway);
this function will pull the task results from the external service and drop them as JSON messages on
an SNS topic - one topic per task group. You can then subscribe to that SNS topic and process the messages.


## Usage
1. Create your task template.
2. Choose a CloudFormation template, based on the external service you're using:
  a. https://s3.amazonaws.com/com.gilt.public.backoffice/cloudformation_templates/task-integrator-mechanical-turk.template
3. Deploy the CloudFormation template, providing all requested parameters.
4. Deploy the CloudFormation template for each stream of tasks:
  a. https://s3.amazonaws.com/com.gilt.public.backoffice/cloudformation_templates/task-integrator-mechanical-turk-task-stream.template
5. Fill in the QualificationRequirement for the task stream.
6. Upload CSVs to S3.
7. Subscribe to the SNS topic and process the task results. If you don't want to miss messages, you should
   create your SNS topics (and subscriptions) ahead of time, in the format: stack_name-hit_layout_id. The
   Lambda function will automaticall create SNS topic if they don't exist, but they won't have subscriptions
   and thus messages will be missed (though they can be found in the logs).
8. Set up alerts on the mechanical-turk-balance metric, to know when your account balance is low.


## Implementations

### Amazon Mechanical Turk

#### Amazon CloudFormation templates
https://s3.amazonaws.com/com.gilt.public.backoffice/cloudformation_templates/task-integrator-mechanical-turk.template
https://s3.amazonaws.com/com.gilt.public.backoffice/cloudformation_templates/task-integrator-mechanical-turk-task-stream.template

#### Config

##### auth
A Map with two key-value pairs: access_key and secret_key. These should come from your Mechanical Turk
AWS account. They are parameters of the CloudFormation template and will be automatically populated into
config as part of the stack creation.

##### task-stream-*
A Map of HIT settings for a stream of Mechanical Turk tasks. This will be created when you use the
task-integrator-mechanical-turk-task-stream.template. The Map will be in this format:

```
{
  "AssignmentDurationInSeconds": 600,
  "AutoApprovalDelayInSeconds": 0,
  "Description": "Example description",
  "HITLayoutId": "hit_layout_id_here",
  "Keywords": "example, keywords",
  "LifetimeInSeconds": 36000,
  "MaxAssignments": 1,
  "Reward": {
    "Amount": 1.00,
    "CurrencyCode": "USD"
  },
  "Title": "Example Title"
}
```

Admittedly, this is awful - because it duplicates the values you already set up in the Mechanical Turk project.
But the Mechanical Turk API does not provide access to these values (only the layout_id) and thus they are a
required part of the config here. There is one config entry per HIT task because the stream name can't be loaded
in as the key of a top-level Map (i.e. the config key name would be 'tasks' and the value would be a Map of
stream-name to HIT settings) - thus the 'task-stream-*' format of the key name (where '*' is replaced by your stream name).

The QualificationRequirement configuration is intentionally left to the user to fill in manually. This is because
the requirement configuration can vary wildly, and it's hard to support all use cases through CloudFormation. If
there proves to be a common use case that should be supported out of the box, we can add that in the future.

##### sandbox
Boolean, indicating whether or not the Mechanical Turk sandbox should be referenced by this stack.

##### turk_notification_queue
This will be automatically set with the SQS queue that is set up during the creation of the CloudFormation
stack. It is the URL of the queue.


#### Annoyances
1. Mechanical Turk only supports notifications to SQS, not SNS - so the notification model is a pull, not a
   push. As such, the Lambda function must be scheduled and can't simply run when the notification happens.

2. No part of the AWS API supports setting up a Scheduled Event event source for a Lambda function. The
   exporter function must poll SQS to receive notifications, so this is necessary. Until Amazon adds support
   for this, the template will subscribe to the Unreliable Town Clock public SNS topic, which provides events
   every 15 mins (https://alestic.com/2015/05/aws-lambda-recurring-schedule). If you need a different schedule,
   feel free to remove this subscription and manually set up your own scheduled event through the UI.


## Design choices

### Including node_modules in the project
We decided to do this in order to streamline the production of the ZIP file that you must upload to S3.
By including the node_modules, the end user doesn't need to do anything other than download the ZIP file
directly from Github. The maintainers of this project will need to keep the node_modules up to date.


### Node.js vs Java
There are some benefits to using Java (Amazon-supported client library for Mechanical Turk, type-safety),
but in a quick test of GetAccountBalance the overhead of loading the Java jars proved to be much slower
than running the Node.js script. The Node.js script ran at about the speed of the Java code when the jars
were pre-loaded - but loading the jars took about 15s, compared with ~750ms to run the code alone. Since
these Lambda functions will be run sparsely - and thus won't be able to take advantage of existing instances
with pre-loaded jars - it seemed smarter (and certainly cheaper) to use Node.js to avoid the jar overhead.


## Maintainers

### Deployment
After making changes, please do the following:

1. Upload this zipped repo to the com.gilt.public.backoffice/lambda_functions bucket. To produce the .zip file:

   ```
     npm install
     zip -r task-integrator.zip . -x *.git* -x *task-integrator.zip*
   ```

   Unfortunately we can't use the Github .zip file directly, because it zips the code into a subdirectory named after
   the repo; AWS Lambda then can't find the .js file containing the integrator functions because it is not on the top-level.

2. Upload the edited templates from ./cloud_formation to com.gilt.public.backoffice/cloudformation_templates


### mturk module
This uses a fork of the mturk module that is interoperable between OSX and Linux: https://github.com/gilt/mturk.
If changes are made there, this project should also be updated.


## License
Copyright 2015 Gilt Groupe, Inc.

Licensed under the Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0