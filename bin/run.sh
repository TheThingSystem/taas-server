#!/bin/bash

ulimit -n 10240
while true; do
  node cloud-server.js > cloud.log 2>&1

  sleep 5
done
