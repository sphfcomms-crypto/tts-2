#!/bin/bash
# put.sh SLOT FILE [content-type]: PUT a file to the presigned URL stored in /project/w/urls/SLOT
ct=${3:-image/jpeg}
curl -s -o /tmp/put.out -w "PUT $1 %{http_code}\n" -X PUT -H "Content-Type: $ct" --data-binary @"$2" "$(tr -d '\n' < /project/w/urls/$1)"
