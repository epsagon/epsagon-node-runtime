# Epsagon's Node.js Runtime
Custom node runtime for AWS Lambda. 100% compatible with AWS's runtime, with some additional features:

* Use handlers from layers: to use a handler, set the environment variable
  `CUSTOM_TASK_ROOT` to `/opt/nodejs/`.
