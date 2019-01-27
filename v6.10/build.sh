#!/bin/sh

export NODE_VERSION=6.10.3

docker build --build-arg NODE_VERSION -t node-provided-lambda-v6.10 .
docker run --rm node-provided-lambda-v6.10 cat /tmp/node-v${NODE_VERSION}.zip > ./layer.zip