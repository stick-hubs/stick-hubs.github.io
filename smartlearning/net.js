// SmartLearning networking.
// It uses the free TurboWarp cloud variable server (the same one Stick Legions II and Stick Lab
// use for online play). Everyone in the same "project" sees every change to a cloud variable,
// so a game room is one project and the server list is another. Cloud variables can only hold
// digits, so each message is JSON turned into UTF-8 bytes, 3 digits per byte.
(function () {
  'use strict';
  var DEFAULT_SERVER = 'wss://clouddata.turbowarp.org';
  var VAR = '☁ m';
  var SEND_GAP = 120; // the server limits how fast one player may send
  var MAX_DIGITS = 90000;

  function serverUrl () {
    try {
      var q = new URLSearchParams(location.search).get('server');
      return q || localStorage.getItem('smartlearning-server') || DEFAULT_SERVER;
    } catch (e) {
      return DEFAULT_SERVER;
    }
  }

  function encode (obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    var out = '1';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 10 ? '00' : bytes[i] < 100 ? '0' : '') + bytes[i];
    return out;
  }

  function decode (value) {
    var s = String(value);
    if (s.charAt(0) !== '1' || (s.length - 1) % 3 !== 0) return null;
    var bytes = new Uint8Array((s.length - 1) / 3);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(s.substr(1 + (i * 3), 3), 10);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      return null;
    }
  }

  /**
   * One connection to one "project" on the cloud server.
   * onMessage(obj) is called for every message from someone else.
   */
  function Channel (projectId, onMessage, onStatus) {
    this.projectId = projectId;
    this.onMessage = onMessage;
    this.onStatus = onStatus || function () {};
    this.queue = [];
    this.timer = null;
    this.socket = null;
    this.closed = false;
    this.open = false;
    this.user = 'player' + (100000 + Math.floor(Math.random() * 899999));
    this.connect();
  }

  Channel.prototype.connect = function () {
    var self = this;
    if (this.closed) return;
    var socket;
    try {
      socket = new WebSocket(serverUrl());
    } catch (e) {
      this.onStatus('error');
      return;
    }
    this.socket = socket;
    socket.onopen = function () {
      socket.send(JSON.stringify({method: 'handshake', user: self.user, project_id: self.projectId}) + '\n');
      self.open = true;
      self.openedAt = Date.now();
      self.onStatus('open');
      self.flush();
    };
    socket.onmessage = function (e) {
      String(e.data).split('\n').forEach(function (line) {
        if (!line) return;
        var msg;
        try { msg = JSON.parse(line); } catch (err) { return; }
        if (msg.method !== 'set' || msg.name !== VAR) return;
        var obj = decode(msg.value);
        if (obj) self.onMessage(obj);
      });
    };
    socket.onclose = function () {
      self.open = false;
      if (self.closed) return;
      self.onStatus('reconnecting');
      setTimeout(function () { self.connect(); }, 1500);
    };
    socket.onerror = function () {};
  };

  Channel.prototype.send = function (obj) {
    obj.t = Date.now();
    var value = encode(obj);
    if (value.length > MAX_DIGITS) return;
    this.queue.push(value);
    this.flush();
  };

  Channel.prototype.flush = function () {
    var self = this;
    if (this.timer || !this.open || !this.queue.length) return;
    var value = this.queue.shift();
    try {
      this.socket.send(JSON.stringify({method: 'set', name: VAR, value: value}) + '\n');
    } catch (e) {
      this.queue.unshift(value);
    }
    this.timer = setTimeout(function () {
      self.timer = null;
      self.flush();
    }, SEND_GAP);
  };

  /** Send what's left, then disconnect. */
  Channel.prototype.close = function (last) {
    var self = this;
    if (last) this.send(last);
    var wait = Math.min(2000, (this.queue.length + 1) * SEND_GAP);
    setTimeout(function () {
      self.closed = true;
      clearTimeout(self.timer);
      if (self.socket) try { self.socket.close(); } catch (e) {}
    }, wait);
  };

  /** A channel for playing alone: nothing goes over the internet. */
  function LocalChannel () {}
  LocalChannel.prototype.send = function () {};
  LocalChannel.prototype.close = function () {};

  window.SLNet = {Channel: Channel, LocalChannel: LocalChannel, encode: encode, decode: decode, serverUrl: serverUrl};
})();
