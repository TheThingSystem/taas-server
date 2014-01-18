#!/bin/bash

ulimit -n 10240
while true; do
  node mini-mqtt-broker.js > broker.log 2>&1

  sleep 5
done
