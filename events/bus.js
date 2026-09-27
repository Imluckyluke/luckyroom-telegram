const { EventEmitter } = require('events');

// Simple in-process event bus. Lets modules (auth, groups, uploads, ...)
// announce that something happened without needing to know who, if
// anyone, cares — future features can subscribe without touching the
// code that emits the event.
class Bus extends EventEmitter {}

module.exports = new Bus();
