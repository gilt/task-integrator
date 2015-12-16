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
2. Choose a CloudFormation template, based on the external service you're using.
3. Deploy the CloudFormation template, providing all requested parameters.
4. Fill in the task config, including the template ids.
5. Upload CSVs to S3.
6. Subscribe to the SNS topic and process the task results.


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