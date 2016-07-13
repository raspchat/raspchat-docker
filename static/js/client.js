/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

if (!Function.prototype.bind){
  Function.prototype.bind = function (scope) {
    var fn = this;
    return function () {
        var args = Array.prototype.slice.call(arguments);
        return fn.apply(scope, args);
      };
  };
}

window.$glueFunctions = function (obj) {
  for (var i in obj) {
    if (obj[i] instanceof Function) {
      obj[i] = obj[i].bind(obj);
    }
  }
};

window.$mix = function (){
    var ret = {};
    if (Object.assign) {
      var args = Array.prototype.slice.call(arguments);
      return Object.assign.apply(Object, args);
    }

    for(var i=0; i<arguments.length; i++)
        for(var key in arguments[i])
            if(arguments[i].hasOwnProperty(key))
                ret[key] = arguments[i][key];
    return ret;
};

window.core = (function(win, doc, raspconfig) {
  var SERVER_ALIAS = 'SERVER';

  var validCommandRegex = /^\/(nick|gif|join|leave|list|switch)\s*(.*)$/i;
  var userCommandToEventsMap = {
    'list': {eventName: 'list-group', paramRequired: false, defaultParam: false},
    'nick': {eventName: 'set-nick', paramRequired: true},
    'switch': {eventName: 'switch-group', paramRequired: true},
    'join': {eventName: 'join-group', paramRequired: true},
    'leave': {eventName: 'leave-group', paramRequired: false, defaultParam: false},
    'gif': {eventName: 'send-gif', paramRequired: true}
  };
  var processComand = function (cmd, callback) {
    var match = cmd.match(validCommandRegex);

    // map should have command
    if (!match || !userCommandToEventsMap[match[1]]){
      return false;
    }

    if (match[1].toLowerCase() == 'help') {
      return true;
    }

    // Invoke matched command
    var selectedCmd = userCommandToEventsMap[match[1]];
    var cmdParam = match[2];
    if (selectedCmd.paramRequired && !cmdParam) {
      return false;
    }
    else
    {
      cmdParam = cmdParam || selectedCmd.defaultParam;
    }

    callback(selectedCmd.eventName, cmdParam);
    return true;
  };

  var getWebSocketConnectionUri = function () {
    var loc = win.location;
    var isSecure = loc.protocol.toLowerCase().endsWith("s:");
    var wsUri = raspconfig && raspconfig.webSocketConnectionUri;
    var wssUri = raspconfig && raspconfig.webSocketSecureConnectionUri;
    var templateString = (isSecure ? wssUri : wsUri) || "{protocol}//{host}/chat";
    var resultString = ""+templateString;
    var replacableHrefProperties = {
      "host": "{host}",
      "port": "{port}",
      "hostname": "{hostname}",
      "pathname": "{path}"
    };

    for (var property in replacableHrefProperties) {
      var placeHolder = replacableHrefProperties[property];
      if (resultString.indexOf(placeHolder) > -1) {
        resultString = resultString.replace(placeHolder, ""+loc[property]);
      }
    }

    resultString = resultString.replace("{protocol}", isSecure ? "wss:" : "ws:");
    return resultString;
  };

  var EventEmitter = function () {
    this._channels = {};
  };

  EventEmitter.prototype = {
    fire: function (channel) {
      var subscribes = this._channels[channel] || [],
          l = subscribes.length,
          data = Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < l; i++) {
        (function (j) {
          var cb = subscribes[j];
          win.setTimeout(function () {
            cb && cb.apply(this, data || [])
          }, 0);
        })(i);
      }
    },

    off: function (channel, handler) {
      var subscribes = this._channels[channel] || [],
          l = subscribes.length;

      while (l--) {
        if (subscribes[l] === handler) {
          subscribes.splice(l, 1);
        }
      }
    },

    on: function (channel, handler) {
      this._channels[channel] = this._channels[channel] || [];
      this._channels[channel].push(handler);
    }
  };

  var Transport = function (url) {
    $glueFunctions(this);
    this.events = new EventEmitter();
    this.sock = null;
    this.handshakeCompleted = false;
    this.url = url || getWebSocketConnectionUri();
  };

  Transport.prototype = {
      connect: function (nick) {
        this.nick = nick;
        this._create_ws_connection();
      },

      setNick: function (nick) {
        this.send(SERVER_ALIAS, "/nick "+nick);
      },

      sendRaw: function (to, msg) {
        this.sock.send(JSON.stringify({"@": "send-raw-msg", to: to, msg: msg}));
      },

      isValidCmd: function (msg) {
        var match = msg.match(validCommandRegex);
        if (!match) {
          return false;
        }

        return true;
      },

      getHistory: function (grp, offset, limit) {
        offset = offset || 0;
        limit = limit || 50;
        var me = this;
        var encodedGroupName = encodeURIComponent(grp);
        atomic.setContentType('application/json');
        atomic.get("/chat/api/channel/"+encodedGroupName+"/message?limit="+limit+"&offset="+offset)
             .success(function (response, xhr) {
               me._on_group_history_recvd(grp, response);
             })
             .error(function (response, xhr) {
               events.fire('history-error', xhr);
             });
      },

      send: function (to, msg) {
        var me = this;
        var processed = processComand(msg, function(cmd, cmdParam){
          if (cmd == "switch-group") {
            me.events.fire('switch', cmdParam);
            return;
          }

          if (cmd == "send-gif") {
            giffer.search(cmdParam, function (url, obj) {
              var t = msg;
              if (url) {
                t = "> !["+cmdParam+"]("+url+")\n\n> **GIF** "+cmdParam+"\n";
              }

              me.sock.send(JSON.stringify({"@": "send-msg", to: to, msg: t}));
            });

            return;
          }

          // Populate /leave <group-name> if <group-name> was not provided
          // Populate /list <group-name> if <group-name> was not provided
          if (cmd == "leave-group" || cmd == "list-group") {
            cmdParam = cmdParam || to;
          }

          me.sock.send(JSON.stringify({'@': cmd, to: to, msg: cmdParam}));
        });

        if (!processed) {
          this.sock.send(JSON.stringify({"@": "send-msg", to: to, msg: msg}));
        }
      },

      _create_ws_connection: function () {
        try{
          if (this.sock && this.sock.close) {
            this.sock.onclose = null;
            this.sock.onopen = null;
            this.sock.onmessage = null;
            this.sock.close();
          }
        }catch(e){
          console && console.error(e);
        }

        this.sock = new WebSocket(this.url);
        this.sock.onopen = this._on_connect;
        this.sock.onclose = this._on_disconnect;
        this.sock.onmessage = this._on_data;
        this.events.fire('connecting');
      },

      _on_connect: function (e) {
        this.events.fire('connected');
      },

      _on_disconnect: function () {
        this.handshakeCompleted = false;
        this.events.fire('disconnected');
        var me = this;
        win.setTimeout(function (){ me._create_ws_connection(); }, 1000);
      },

      _on_data: function (e) {
        var data = {};
        try {
          data = JSON.parse(e.data);
        }catch(er){
          console && console.error("Error decoding", e.data, er);
        }

        if (data['@']) {
          this._handleMessage(data);
        }
      },

      _completeHandShake: function (msg) {
        if (!this.handshakeCompleted) {
          this.handshakeCompleted = true;
          this.setNick(this.nick);
          this.events.fire('handshake', SERVER_ALIAS);
          this.events.fire('message', {
            from: SERVER_ALIAS,
            to: SERVER_ALIAS,
            msg: "```"+msg.msg+"```",
          });
        }
      },

      _handleMessage: function (msg) {

        // Switch case for handling message types
        // Ideal is to create a map and invoke methods directly
        switch (msg['@']) {
          case SERVER_ALIAS:
            this._completeHandShake(msg);
            break;

          case 'group-join':
            this._on_group_joined(msg);
            break;

          case 'group-leave':
            this._on_group_left(msg);
            break;

          case 'group-message':
            this._on_message(msg);
            break;

          case 'nick-set':
            this._on_nick_changed(msg);
            break;

          case 'member-nick-set':
            this._on_member_nick_changed(msg.to, msg.pack_msg);
            break;

          case 'group-list':
            this._on_group_members_list(msg.to, msg.pack_msg);
            break;

          case 'new-raw-msg':
            this._on_rawmessage(msg.to, msg.pack_msg);
            break;

          case 'ping':
            this.sock.send(JSON.stringify({'@': 'pong', t: msg.t}));
            break;

          default:
            break;
        }
      },

      _on_rawmessage: function (from, msg) {
        this.events.fire('raw-message', from, msg);
      },

      _on_message: function (msg) {
        msg.delivery_time = msg.delivery_time || new Date();
        this.events.fire('message', msg);
      },

      _on_group_joined: function (msg) {
        var events = this.events;
        events.fire('message', {
          from: SERVER_ALIAS,
          to: SERVER_ALIAS,
          delivery_time: new Date(),
          msg: msg.from + " joined " + msg.to
        });

        events.fire('joined', msg);
        this.getHistory(msg.to);
      },

      _on_group_history_recvd: function (grp, hist) {
        var historyMessages = hist.messages.map(this._prepareMetaMessage).reverse();
        this.events.fire('history', $mix(hist, {messages: historyMessages}));
      },

      _prepareMetaMessage: function (msg) {
        var ret = $mix(msg);
        switch (msg['@']) {
          case 'group-join':
            ret.meta = {action: 'joined'};
            break;
          case 'group-leave':
            ret.meta = {action: 'leave'};
            break;
          default:
            ret.meta = null;
        }

        return ret;
      },

      _on_group_members_list: function (to, list) {
        this.events.fire('members-list', to, list);
      },

      _on_group_left: function (recpInfo) {
        this.events.fire('message', {
          from: SERVER_ALIAS,
          to: SERVER_ALIAS,
          delivery_time: new Date(),
          msg: recpInfo.from + " left " + recpInfo.to
        });
        this.events.fire('leave', recpInfo);
      },

      _on_nick_changed: function (msg) {
        this.nick = msg.newNick;
        this.events.fire('nick-changed', msg.newNick, msg.oldNick);
      },

      _on_member_nick_changed: function (group, nickInfo) {
        this.events.fire('message', {
          to: group,
          msg: nickInfo.oldNick + " changed nick to " + nickInfo.newNick,
          from: nickInfo.newNick,
          delivery_time: new Date(),
        });
      },
  };

  Transport.HelpMessage = "Valid commands are: \n"+
            "/help for this help :)\n" +
            "/list for list of members in a group\n"+
            "/gif <gif-keywords> to send a gif \n"+
            "/join <group_name> to join a group (case-sensitive)\n"+
            "/nick <new_name> for changing your nick (case-sensitive)\n"+
            "/switch <group_name> to switch to a joined group (case-sensitive)\n";

  var _globalTransport = {};

  var giffer = {
    search: function (keywords, url_callback) {
      keywords = encodeURIComponent(keywords);
      atomic.setContentType('application/json');
      atomic.get("/gif?q="+keywords)
           .success(function (response, xhr) {
             url_callback(response.url, response);
           })
           .error(function (response, xhr) {
             url_callback(null, null);
           });
    }
  };

  return {
    Transport: Transport,
    EventEmitter: EventEmitter,
    GetTransport: function (name, url) {
      _globalTransport[name] = _globalTransport[name] || new Transport(url);
      return _globalTransport[name];
    },
  };
})(window, window.document, window.RaspConfig);

core.p2p = (function (win) {
  var moz = !!win.mozRTCPeerConnection;
  var PeerConnection = win.RTCPeerConnection || win.mozRTCPeerConnection || win.webkitRTCPeerConnection,
      SessionDescription = win.RTCSessionDescription || win.mozRTCSessionDescription || win.webkitRTCSessionDescription,
      IceCandidate = win.RTCIceCandidate || win.mozRTCIceCandidate || win.webkitRTCIceCandidate;

  var Peer2PeerDataConnection = function (opts) {
    $glueFunctions(this);
    this.options = opts || {channel: "WebRTCPeer", reliable: true};
    var servers = {
      iceServers: [
          {urls: "stun:23.21.150.121"},
          {urls: "stun:stun.l.google.com:19302"},
          {urls: "turn:numb.viagenie.ca", credential: "Hello123", username: " stun-register@yopmail.com"}
      ]
    };
    var pcConstraint = null;

    this.events = new core.EventEmitter();
    this.peerConnection = new PeerConnection(servers, pcConstraint);

    this.offers = [];
    this.iceCandidates = [];
    this.peerConnection.onicecandidate = this.onICECandidate;
    this.peerConnection.ondatachannel = this.onRecvDataChannel;

    var me = this;
  };

  Peer2PeerDataConnection.prototype = {
    close: function () {
      if (this.channel) {
        this.channel.close();
        this.channel = null;
      }

      if (this.peerConnection){
        this.peerConnection.close();
        this.offers = [];
        this.icecandidates = [];
        this.peerConnection = null;
      }
    },
    onICECandidate: function (e) {
      if (e.candidate) {
        this.iceCandidates.push(e.candidate);
        this.events.fire('candidate', e.candidate);
      }
    },
    addICECandidates: function (candidates) {
      for (var i = 0; i < candidates.length; i++) {
        console.log("Adding candidate", candidates[i]);
        this.peerConnection.addIceCandidate(new IceCandidate(candidates[i]));
      }
    },
    createOffer: function (cb) {
      var me = this;
      me.peerConnection.createOffer(
        function (descriptor) {
          me.peerConnection.setLocalDescription(descriptor);
          me.offers.push(descriptor);
          win.setTimeout(function () {
            cb && cb(descriptor);
          }, 0);
          me.events.fire("offer", descriptor);
          me.events.fire("offer.sdp", descriptor.sdp);
        }, function (e) {
          me.events.fire("offer.error", e);
        });
    },
    answerOffer: function (desc, cb) {
      var remoteDesc = new SessionDescription(desc);
      var me = this;
      me.peerConnection.setRemoteDescription(remoteDesc);
      me.peerConnection.createAnswer(
        function (descriptor) {
          me.peerConnection.setLocalDescription(descriptor);
          win.setTimeout(function () {
            cb && cb(descriptor);
          }, 0);
          me.events.fire("answer", descriptor);
          me.events.fire("answer.sdp", descriptor.sdp);
        }, function (e) {
          me.events.fire("answer.error", e);
        });
    },
    acceptAnswer: function (remoteDescriptor) {
      var remoteDesc = new SessionDescription(remoteDescriptor);
      var me = this;
      me.peerConnection.setRemoteDescription(remoteDesc);

    },
    createDataChannel: function () {
      this.channel = this.peerConnection.createDataChannel(
        this.options.channel || "WebRTCPeer",
        {
          reliable: (this.options.reliable || false)
        });

      this.hookDataChannelEvents();
    },
    onRecvDataChannel: function (event) {
      this.channel = event.channel;
      this.hookDataChannelEvents();
    },
    hookDataChannelEvents: function () {
      var me = this;
      var eventShooter = function (name) {
        return function (args) {
          me.events.fire(name, args);
        };
      };

      this.channel.onerror = eventShooter('error');
      this.channel.onmessage = eventShooter('message');
      this.channel.onopen = eventShooter('open');
      this.channel.onclose = eventShooter('close');
    },
  };

  return {
    Peer2PeerDataConnection: Peer2PeerDataConnection,
  };
})(window);

window.core.PeerConnectionNegotiator = (function (win) {

  var installPeerDebugHooks = function (peerConnection) {
      peerConnection.events.on('offer', function (desc) {
        console.log("OFFER", desc);
      });

      peerConnection.events.on("candidate", function (c) {
        console.log("CANDIDATE", c);
      });

      peerConnection.events.on("open", function () {
        console.log("OPENED", peerConnection.channel);
      });

      peerConnection.events.on("close", function () {
        console.log("CLOSED", peerConnection.channel);
      });

      peerConnection.events.on("message", function (msg) {
        console.log("MESSAGE", msg);
      });
  };

  var PeerConnectionNegotiator = function (transport, options) {
    $glueFunctions(this);
    this.events = new core.EventEmitter();
    this.dataBuffer = [];
    this.channel = null;

    this.peerConnection = new core.p2p.Peer2PeerDataConnection(options);
    this.peerConnection.events.on("open", this.onPCOpen);
    this.peerConnection.events.on("close", this.onPCClose);
    this.peerConnection.events.on("error", this.onPCError);
    this.peerConnection.events.on("data", this.onPCData);

    this.transport = transport;
    this.transport.events.on("raw-message", this.onOfferRecv);
    this.transport.events.on("raw-message", this.onAnswerRecv);

    installPeerDebugHooks(this.peerConnection);
  };

  PeerConnectionNegotiator.prototype = {
    close: function () {
      this.transport.events.off("raw-message", this.onOfferRecv);
      this.transport.events.off("raw-message", this.onAnswerRecv);
      this.peerConnection.close();

      this.channel = null;
      this.peerConnection = null;
      this.transport = null;
    },

    onPCOpen: function () {
      for(var i = 0; i < this.dataBuffer.length; i++){
        this.channel.send(this.dataBuffer[i]);
      }

      this.channel = this.peerConnection.channel;
      this.events.fire("ready", this.peerConnection.channel);
    },

    onPCClose: function () {
      var oldCh = this.channel;
      this.channel = null;
      this.events.fire("close", oldCh);
    },

    onPCError: function (err) {
      this.events.fire("error", err);
    },

    onPCData: function (event) {
      this.events.fire("data", event.data, event);
    },

    send: function (data) {
      if (!this.channel) {
        this.dataBuffer.push(data);
        return;
      }

      this.channel.send(data);
    },

    onOfferRecv: function (from, reqMsg) {
      if (reqMsg.type != "P2PHandShake" || reqMsg.mode != "RequestOffer") {
        return;
      }

      console.log("RequestOffer", reqMsg);
      var me = this;
      me.peerConnection.answerOffer(reqMsg.offer, function (offer) {
        if (reqMsg.candidates) {
          me.peerConnection.addICECandidates(reqMsg.candidates);
          win.setTimeout(function () {
            me.transport.sendRaw(from, {
              type: "P2PHandShake",
              mode: "OfferResponse",
              offer: offer,
              candidates: me.peerConnection.iceCandidates});
            console.log("OfferedResponse", reqMsg);
          }, 3000);
        }
      });
    },

    onAnswerRecv: function (from, reqMsg) {
      if (reqMsg.type != "P2PHandShake" || reqMsg.mode != "OfferResponse") {
        return;
      }

      console.log("OfferResponse", reqMsg);
      this.peerConnection.acceptAnswer(reqMsg.offer);
      if (reqMsg.candidates) {
        this.peerConnection.addICECandidates(reqMsg.candidates);
      }
    },

    connectTo: function (to) {
      var me = this;
      me.peerConnection.createDataChannel();
      me.peerConnection.createOffer(function (offer) {
        win.setTimeout(function () {
          me.transport.sendRaw(to, {
            type: "P2PHandShake",
            mode: "RequestOffer",
            offer: offer,
            candidates: me.peerConnection.iceCandidates
          });
        }, 2000);
      });
    },
  };

  return PeerConnectionNegotiator;
})(window);

(function (win, vue) {
})(window, Vue);

/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  vue.component('app-bar', vue.extend({
    template: '#app-bar',
    props: ['userId'],
    data: function () {
      return {};
    },
    ready: function () {
    },
    methods: {
    }
  }))
})(Vue, window, window.document);

/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  vue.component('chat-compose', vue.extend({
    template: '#chat-compose',
    data: function () {
      return {
        message: '',
      };
    },
    methods: {
      enterPressed: function (e) {
        var msg = this.message;
        if (e.shiftKey){
          this.$set('message', msg+'\n');
          return;
        }

        this.$set('message', '');
        this.$dispatch('send-message', msg);
        this.$el.querySelector(".msg").focus();
      },

      tabPressed: function () {
        var msg = this.$get('message');
        this.$set('message', msg+'  ');
      },
    },
  }));
})(Vue, window, window.document);
/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  vue.component('chat-log', vue.extend({
    props: ['messages'],
    template: '#chat-messages',
    ready: function () {
      this.$el.addEventListener("click", function (event) {
        event = event || win.event;

        if (event.target.tagName == "A") {
          win.open(event.target.href, "_blank");
          event.preventDefault();
          event.stopPropagation();
        }
      }, false);

      this.userScrolled = false;
      this.selfScroll = false;
      this.cont = this.cont || this.$el.querySelector(".chat-messages");
      this.timer = win.setInterval(this.scrollToBottom, 500);
    },
    methods: {
      onScroll: function (e) {
        if (this.selfScroll) {
          this.selfScroll = false;
          return;
        }

        var container = this.cont;
        this.userScrolled = container.scrollHeight - container.offsetHeight - container.scrollTop > 50;
      },

      scrollToBottom: function (e) {
        if (this.userScrolled) {
          return;
        }

        var container = this.cont;
        var loadedEventImage = e && e.loadedEventImage;
        container.scrollTop = container.scrollHeight;
        this.selfScroll = true;
      }
    },
  }));
})(Vue, window, window.document);

/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  vue.component('chat-message', vue.extend({
    props: ['message'],
    template: '#chat-message',
    ready: function () {
      this.hookImageLoads();
      this.$dispatch("chat-message-added", this.message);

      this.$watch("message.msg", function () {
        this.hookImageLoads();
        this.$dispatch("chat-message-added", this.message);
      }.bind(this));
    },
    methods: {
      imageLoaded: function (ev) {
        var me = this;
        me.$dispatch('chat-image-loaded', {loadedEventImage: ev});
      },
      hookImageLoads: function () {
        var imgs = this.$el.parentNode.querySelectorAll("img");
        for(var i in imgs){
          var img = imgs[i];
          if (this._hasClass(img, "avatar")) {
            continue;
          }

          if (img.addEventListener) {
            img.removeEventListener("load", this.imageLoaded);
            img.addEventListener("load", this.imageLoaded, false);
          }
        }
      },

      _hasClass: function (element, selectorClass) {
        var idx = (" " + element.className + " ").replace(/[\n\t]/g, " ").indexOf(selectorClass);
        return  idx > -1;
      }
    }
  }));
})(Vue, window, window.document);

/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  vue.component('chrome-bar', vue.extend({
    props: ['title', 'userId'],
    template: '#chrome-bar',
    data: function () {
      return {
        hamburgerActive: false,
      };
    },
    methods: {
      hamburgerClicked: function () {
        this.$set('hamburgerActive', !this.hamburgerActive);
        this.$dispatch("hamburger-clicked", this.hamburgerActive);
      }
    }
  }));
})(Vue, window, window.document);
(function (vue, win, doc) {
  var md = new markdownit("default", {
    linkify: true,
  });

  vue.filter('markdown', function (value) {
    return md.render(value);
  });

  vue.filter('better_date', function (value) {
    return moment(value).calendar();
  });

  vue.filter('escape_html', function (value) {
    return he.encode(value);
  });

  vue.filter('falsy_to_block_display', function (value) {
    return value ? 'block' : 'none';
  });


  var fragmentNode = document.createDocumentFragment();
  var virtualDiv = document.createElement('div');
  fragmentNode.appendChild(virtualDiv);
  vue.filter('emojify', function (value) {
    if (!emojify) {
      return value;
    }

    virtualDiv.innerHTML = value;
    emojify.run(virtualDiv);
    return virtualDiv.innerHTML;
  });

  vue.filter('avatar_url', function (value) {
    // return '//api.adorable.io/avatars/face/eyes6/nose7/face1/AA0000';
    return '//api.adorable.io/avatars/256/zmg-' + value + '.png';
  });
})(Vue, window, window.document);

/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  vue.component('groups-list', vue.extend({
    template: '#groups-list',
    data: function () {
      return {
        groups: [],
        selected: "",
      };
    },
    ready: function () {
      this.groupsInfo = {};
      this.$on("group_joined", this.groupJoined);
      this.$on("group_switched", this.groupSwitch);
      this.$on("group_left", this.groupLeft);
      this.$on("message_new", this.newMessage)
    },
    methods: {
      selectGroup: function (id) {
        this._setUnread(id, 0);
        this.$set("selected", id);
        this.$dispatch("switch", id);
      },

      leaveGroup: function (id) {
        this.$dispatch("leave", id);
      },

      groupSwitch: function (group) {
        this.selectGroup(group);
      },

      groupJoined: function (group) {
        var groupInfo = this.groupsInfo[group] = this.groupsInfo[group] || {name: group, unread: 0, index: this.groups.length};
        this.groups.push(groupInfo);
      },

      groupLeft: function (group) {
        var g = this.groupsInfo[group] || {index: -1};
        if (g.index != -1){
          this.groups.splice(g.index, 1);
        }
      },

      newMessage: function (msg) {
        if (this.selected == msg.to || !this.groupsInfo[msg.to]) {
          return true;
        }

        this._setUnread(msg.to, this._getUnread(msg.to) + 1);
        return true;
      },

      _getUnread: function (g) {
        return (this.groupsInfo[g] && this.groupsInfo[g].unread) || 0;
      },

      _setUnread: function (g, count) {
        vue.set(this.groupsInfo[g], "unread", count);
        return true;
      }
    }
  }))
})(Vue, window, window.document);
/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc, raspconfig) {
  var signInConfig = raspconfig.externalSignIn || {useProviders: false};
  var InvalidNickCharactersRegex = /[^a-zA-Z0-9]+/ig

  vue.component('google-sign-in', {
    template: '<div id="google-sign-in"></div>',

    ready: function () {
      if (!signInConfig.googleClientId) {
        return;
      }

      var head = doc.querySelector('head');
      var meta = doc.createElement('meta');
      meta.name = 'google-signin-client_id';
      meta.content = signInConfig.googleClientId;
      head.appendChild(meta);
      vue.nextTick(this.loadScript);
   },

   methods: {
     loadScript: function () {
       var funcName = '__google_sign_in_'+(new Date().getTime());
       var me = this;
       win[funcName] = this.scriptLoaded;
       var head = doc.querySelector('head');
       var script = doc.createElement('script');
       script.type='text/javascript';
       script.src='//apis.google.com/js/platform.js?onload='+funcName;
       head.appendChild(script);
     },

     scriptLoaded: function () {
       gapi.signin2.render('google-sign-in', {
        'scope': 'profile email',
        'width': 240,
        'height': 50,
        'longtitle': true,
        'theme': 'light',
        'onsuccess': this.onSuccess,
        'onfailure': this.onFailure
      });
     },

     onSuccess: function (user) {
       var profile = user.getBasicProfile();
       var userId = (profile.getEmail().split("@"))[0];
       var userInfo = {id: userId, name: profile.getName(), host: "google"};
       this.$dispatch("success", userInfo, user);
     },

     onFailure: function (err) {
       this.$dispatch("fail", err);
     }
   }

  });

  vue.component('login-form', {
    template: '#login-form',
    data: function () {
      return {
        isReady: false,
        isSignedIn: false,
        isValidNick: false,
        nick: '',
      };
    },

    ready: function () {
      this.$set('isReady', true);
      this.$watch('nick', this.onNickChanged);
      if (!signInConfig.useProviders) {
        this.$set('isSignedIn', true);
      }
    },

    methods: {
      googleSignInSuccess: function (userInfo) {
        localStorage["userInfo"] = JSON.stringify(userInfo);
        this.$set('isSignedIn', true);
        if (localStorage["userNick"]) {
          this.$set('nick', localStorage["userNick"]);
        } else {
          this.$set('nick', userInfo.id);
        }
      },

      onNickChanged: function () {
        if (this.nick.length > 0  && !this.nick.match(InvalidNickCharactersRegex)) {
          this.$set('isValidNick', true);
        }
        else {
          this.$set('isValidNick', false);
        }
      },

      signin: function () {
        if (!this.isValidNick) {
          return;
        }

        localStorage["userNick"] = this.nick;
        this.$dispatch('login', this.nick);
      }
    }
  });
})(Vue, window, window.document, window.RaspConfig);

/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  var ToggleButtonMixin = {
    data: function () {
      return {enabled: false};
    },
    methods: {
      toggle: function () {
        var oldValue = this.$get("enabled");
        this.$set("enabled", !oldValue);
        this.onEnableChanged && this.onEnableChanged(oldValue);
      }
    }
  };

  vue.component('toast-notification-button', vue.extend({
    template: '#toast-notification-button',
    mixins: [ToggleButtonMixin],
    props: ["ignoreFor"],
    ready: function () {
      this.$set("enabled", Notification.permission === 'granted');
      this.$on("message_new", this.onNotification);
    },

    methods: {
      onNotification: function (msg, metaInfo) {
        if (!this.$get('enabled') ||
            metaInfo.noNotification ||
            msg.from == this.ignoreFor ||
            doc.hasFocus()) {
          return;
        }

        var bodyText =  ""+msg.msg;
        if (bodyText.length > 64) {
          bodyText = bodyText.substring(0, 64) + "...";
        }

        new Notification(msg.from, {body: bodyText, icon: "/static/favicon/favicon.ico"});
      },

      onEnableChanged: function (oldValue) {
        if (oldValue == false && Notification.permission !== 'granted') {
          Notification.requestPermission(this.onPermissionChanged);
        }
      },

      onPermissionChanged: function (permission) {
        if (permission !== 'granted' && this.$get('enabled')) {
          this.$set('enabled', false);
        }
      }
    }
  }));

  vue.component('sound-notification-button', vue.extend({
    template: '#sound-notification-button',
    mixins: [ToggleButtonMixin],
    props: ["defaultEnabled", "ignoreFor"],
    ready: function () {
      this.pingSound = new Audio("/static/ping.mp3");
      this.playingSound = false;

      if (this.defaultEnabled){
        this.$set("enabled", true);
      }

      this.$on("message_new", this.onNotification);
    },
    methods: {
      onNotification: function (msg, metaInfo) {
        if (this.playingSound) {
          return;
        }

        if (this.enabled && !metaInfo.noNotification && msg.from != this.ignoreFor){
          this.pingSound.play();
          this.playingSound = true;
          win.setTimeout(this.markPlayed, 1000);
        }
      },

      markPlayed: function () {
        this.playingSound = false;
      }
    }
  }));
})(Vue, window, window.document);

/*
Copyright (c) 2015 Zohaib
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

(function (vue, win, doc) {
  var groupsLog = {};
  var vueApp = new vue({
    el: '#root',
    data: {
      nick: "",
      currentGroup: {name: '', messages: []},
      isConnected: false,
      isConnecting: false,
      isReady: false,
      showAppBar: false,
    },

    ready: function () {
      if (this.$el.offsetWidth > 600){
        this.$set("showAppBar", true);
      }

      this.transport = core.GetTransport("chat");
      this.transport.events.on('connected', this.onConnected);
      this.transport.events.on('disconnected', this.onDisconnected);
      this.transport.events.on('handshake', this.onHandshaked);

      this.transport.events.on('raw-message', this.onRawMessage);
      this.transport.events.on('message', this.onMessage);
      this.transport.events.on('joined', this.onJoin);
      this.transport.events.on('leave', this.onLeave);
      this.transport.events.on('switch', this.onSwitch);
      this.transport.events.on('history', this.onHistoryRecv);
      this.transport.events.on('nick-changed', this.changeNick);
      this.transport.events.on('members-list', this.onMembersList);

      this.$on("switch", this.onSwitch);
      this.$on("leave", function (group) {
        this.transport.send(group, "/leave "+group);
      });

      this.$on("hamburger-clicked", function (v) {
        this.$set("showAppBar", !this.showAppBar);
      });

      this.$watch("currentGroup.name", function (newVal, oldVal) {
        this.$broadcast("group_switched", newVal);
      });
    },

    methods: {
      onSignedIn: function (nick) {
        this.$set('nick', nick);
        this.connect();
      },

      connect: function () {
        this.$set("isConnecting", true);
        this.$set("isConnected", true);
        this.transport.connect(this.nick);
      },

      sendMessage: function (msg) {
        // Don't let user send message on default group
        if (msg[0] == '/' && (!this.transport.isValidCmd(msg) || msg.toLowerCase().startsWith("/help")))
        {
          this._appendMetaMessage(this.currentGroup.name, core.Transport.HelpMessage);
          return;
        }

        this.transport.send(this.currentGroup.name, msg);
      },

      onRawMessage: function (from, msg) {
        if (msg.type != "Negotiate") {
          return;
        }

        this._appendMetaMessage(this.currentGroup.name, "DCC to "+from);
        var p = new core.PeerConnectionNegotiator(this.transport);
        p.events.on("close", function () {
          p.close();
        });
        p.connectTo(from);
      },

      switchGroup: function (grp) {
        this.onSwitch(grp);
      },

      onMembersList: function (group, list) {
        this._appendMessage({
          to: group,
          from: this.defaultGroup,
          msg: "Channel members for **"+group+"**\n\n - " + list.join("\n - "),
          delivery_time: new Date()
        });
      },

      onHandshaked: function (info_channel) {
        this.defaultGroup = info_channel;
        this.transport.send(this.defaultGroup, "/join lounge");
      },

      onMessage: function (m) {
        this._appendMessage(m);
      },

      onConnected: function () {
        this.$set('isConnected', true);
        this.$broadcast("connection_on");
      },

      changeNick: function (newNick) {
        this.$set('nick', newNick);
      },

      onDisconnected: function () {
        this.$set("isConnecting", true);
        this.$broadcast("connection_off");
      },

      onJoin: function (joinInfo) {
        this._getOrCreateGroupLog(joinInfo.to);
        this._appendMetaMessage(joinInfo.to, joinInfo.from + " has joined");
        if (this.currentGroup.name == this.defaultGroup) {
          this.switchGroup(joinInfo.to);
        }

        if (this.isConnecting) {
          this.$set("isConnecting", false);
        }
      },

      onLeave: function (info) {
        if (info.from == this.nick) {
          delete groupsLog[info.to];
          this.$broadcast("group_left", info.to);
        } else {
          this._appendMetaMessage(info.to, info.from + " has left");
        }

        if (this.currentGroup.name == info.to && this.nick == info.from) {
          this.switchGroup(this.defaultGroup);
        }
      },

      onSwitch: function (group) {
        if (this.$el.offsetWidth < 600) {
          this.$set("showAppBar", false);
        }

        if (!this._getGroupLog(group)) {
          alert('You have not joined group '+group);
          return true;
        }

        if (this.currentGroup.name == group) {
          return true;
        }

        this.$broadcast('group-switching', group);
        this.$set('currentGroup.name', group);
        this.$set('currentGroup.messages', groupsLog[group]);
        this.$broadcast('group-switched', group);
        return false;
      },

      onHistoryRecv: function (historyObj) {
        var msgs = historyObj.messages;

        this._clearGroupLogs();
        for (var i in msgs) {
          var m = msgs[i];
          if (!m.meta) {
            this._appendMessage(m, true);
          } else {
            switch (m.meta.action) {
              case 'joined':
                this.onJoin(m);
                break;
            }
          }
        }

        this.$broadcast('history-added', historyObj.id);
      },

      _appendMessage: function (m, silent) {
        var groupLog = this._getOrCreateGroupLog(m.to);

        if (!this.currentGroup.name) {
          this.$set('currentGroup.name', m.to);
          this.$set('currentGroup.messages', groupLog);
        }

        if (groupLog.length && groupLog[groupLog.length - 1].from == m.from) {
          var lastMsg = groupLog[groupLog.length - 1];
          lastMsg.msg += "\n\n" + m.msg;
        } else {
          groupLog.push(m);
        }

        this._limitGroupHistory(m.to);

        // no need
        if (silent) {
          return;
        }

        this.$broadcast('message_new', m, {noNotification: m.to == this.defaultGroup});
      },

      _appendMetaMessage: function (group, msg) {
        var groupLog = this._getOrCreateGroupLog(group);

        if (!this.currentGroup.name) {
          this.$set('currentGroup.name', group);
          this.$set('currentGroup.messages', groupLog);
        }

        groupLog.push({isMeta: true, msg: msg});
        this._limitGroupHistory(group);
      },

      _limitGroupHistory: function (group, limit) {
        limit = limit || 100;
        var log = this._getOrCreateGroupLog(group);

        if (log.length > limit) {
          log.splice(0, log.length - limit);
        }
      },

      _getOrCreateGroupLog: function (g) {
        if (!groupsLog[g]) {
          groupsLog[g] = [];
          this.$broadcast("group_joined", g);
        }

        return groupsLog[g];
      },

      _clearGroupLogs: function (g) {
        var logs = this._getGroupLog(g);
        if (logs) logs.splice(0, logs.length);
      },

      _getGroupLog: function (g) {
        return groupsLog[g] || null;
      }
    },
  });
})(Vue, window, window.document);
