#!/bin/bash

#trivy
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

#semgrep
docker stop semgrep; docker rm semgrep; docker image rm semgrep
docker pull semgrep/semgrep
docker run -it --name semgrep semgrep/semgrep sh
# Inside container:
git clone --depth=1 https://github.com/semgrep/semgrep-rules.git /rules
# ctrl+d 
docker export -o semgrep.tar semgrep
gzip semgrep.tar
split -b 50m semgrep.tar.gz semgrep.tar.gz.part
rm semgrep.tar.gz
git add .
git commit -m 'semgrep'
git push