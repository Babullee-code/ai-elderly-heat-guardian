#!/usr/bin/env node
/**
 * A local MQTT broker and a fake sensor, for trying the bridge without one.
 *
 * Exists because a bridge is hard to believe until you watch a message go in
 * one end and a resident's screen change at the other. Run this, run the
 * bridge against `mqtt://localhost:1883`, and the chain is visible end to end
 * on one laptop.
 *
 * This is a development aid, not part of the platform. A real deployment uses
 * whatever broker the home or the care provider already runs.
 *
 * USAGE
 *   node test-broker.mjs                       # broker + publisher
 *   node test-broker.mjs --broker-only         # broker, no fake sensor
 *   node test-broker.mjs --topic home/x/temp --min 20 --max 24
 */

import net from 'node:net';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';

function parseArgs(argv) {
  const args = {
    port: 1883,
    brokerOnly: false,
    interval: 3,
    topic: 'home/wang/livingroom/temperature',
    humidityTopic: 'home/wang/livingroom/humidity',
    min: 26,
    max: 33,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--broker-only') args.brokerOnly = true;
    else if (arg === '--interval') args.interval = Number(argv[++i]);
    else if (arg === '--topic') args.topic = argv[++i];
    else if (arg === '--min') args.min = Number(argv[++i]);
    else if (arg === '--max') args.max = Number(argv[++i]);
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

// Aedes 7 removed the default constructor in favour of an async factory.
const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);

const stamp = () => new Date().toLocaleTimeString();

server.listen(args.port, () => {
  console.log('MQTT broker listening on mqtt://localhost:' + args.port);

  if (args.brokerOnly) {
    console.log('(no fake sensor; publish your own messages)');
    return;
  }

  const client = mqtt.connect('mqtt://localhost:' + args.port);

  let temp = (args.min + args.max) / 2;
  let humidity = 62;

  client.on('connect', () => {
    console.log(
      'fake sensor publishing every ' + args.interval + 's:\n' +
      '  ' + args.topic + '  (bare number)\n' +
      '  ' + args.humidityTopic + '  (JSON with a timestamp)\n',
    );

    setInterval(() => {
      temp += (Math.random() - 0.45) * 0.6;
      temp = Math.min(args.max, Math.max(args.min, temp));
      humidity = Math.min(95, Math.max(30, humidity + (Math.random() - 0.5) * 2));

      const t = temp.toFixed(1);

      // Two payload shapes on purpose, because real sensors disagree: a bare
      // number, and JSON carrying its own timestamp.
      client.publish(args.topic, t);
      client.publish(
        args.humidityTopic,
        JSON.stringify({ value: Math.round(humidity), ts: new Date().toISOString() }),
      );

      console.log(stamp() + '  published  temp=' + t + '  humidity=' + Math.round(humidity));
    }, args.interval * 1000);
  });
});

process.on('SIGINT', () => {
  console.log('\nstopping broker');
  server.close(() => process.exit(0));
});
