#!/bin/bash

docker stop trivy; docker rm trivy; docker image rm trivycontainer
docker pull aquasec/trivy
docker run --name trivy --entrypoint sh -it aquasec/trivy
trivy image --download-db-only
trivy image --download-java-db-only

# ctrl-d

docker export -o trivycontainer.tar trivy
gzip trivycontainer.tar
split -b 50m trivycontainer.tar.gz trivycontainer.tar.gz.part
rm trivycontainer.tar.gz

# git
git add .
git commit -m 'trivy'
git push