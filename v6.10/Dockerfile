FROM lambci/lambda-base:build

COPY bootstrap bootstrap.js /opt/

ARG NODE_VERSION

RUN curl -sSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz | \
  tar -xJ -C /opt --strip-components 1 -- node-v${NODE_VERSION}-linux-x64/bin/node && \
  strip /opt/bin/node

RUN curl -sSL https://www.npmjs.org/install.sh | PATH=/opt/bin/:$PATH sh

RUN mkdir /opt/runtime
RUN cd /opt/runtime
RUN PATH=/opt/bin:$PATH npm install aws-sdk@2.290.0 dynamodb-doc@1.0.0 imagemagick@0.1.3 lodash@4.17.5

RUN rm -r /opt/lib /opt/bin/npm /opt/bin/npx /opt/share
RUN mv /var/task/node_modules /opt/runtime/

RUN cd /opt && \
  zip -yr /tmp/node-v${NODE_VERSION}.zip ./*
