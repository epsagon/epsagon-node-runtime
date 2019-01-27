#!/bin/sh

deploy_folder() {
    cd $1;
    rm layer.zip &&
        ./build.sh &&
        ./publish.sh;
    result=$?;
    cd ..;
    return $result;
}

for folder in v6.10 v8.10; do
    deploy_folder $folder || (echo "version publish failed" && exit 1);
done;