#!/bin/bash
# up.sh SLOT FILE [content-type] : PUT a file to the presigned URL stored in /project/build/urls/SLOT
ct=${3:-image/jpeg}
curl -s -o /dev/null -w "PUT %{http_code}\n" -X PUT -H "Content-Type: $ct" --data-binary @"$2" "$(cat /project/build/urls/$1)"
