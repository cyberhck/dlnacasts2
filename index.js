var MediaRenderer = require('upnp-mediarenderer-client')
var debug = require('debug')('dlnacasts')
var events = require('events')
var get = require('simple-get')
var mime = require('mime')
var parallel = require('run-parallel')
var parseString = require('xml2js').parseString

// region monkey patching media renderer
MediaRenderer.prototype.load = function(url, options, callback) {
  var self = this;
  if(typeof options === 'function') {
    callback = options;
    options = {};
  }

  var dlnaFeatures = options.dlnaFeatures || '*';
  var contentType = options.contentType || 'video/mpeg'; // Default to something generic
  var protocolInfo = 'http-get:*:' + contentType + ':' + dlnaFeatures;


  var metadata = options.metadata || {};
  metadata.url = url;
  metadata.protocolInfo = protocolInfo;

  var params = {
    RemoteProtocolInfo: protocolInfo,
    PeerConnectionManager: null,
    PeerConnectionID: -1,
    Direction: 'Input'
  };

  this.callAction('ConnectionManager', 'PrepareForConnection', params, function(err, result) {
    if(err) {
      if(err.code !== 'ENOACTION') {
        return callback(err);
      }
      //
      // If PrepareForConnection is not implemented, we keep the default (0) InstanceID
      //
    } else {
      self.instanceId = result.AVTransportID;    
    }

    var params = {
      InstanceID: self.instanceId,
      CurrentURI: url,
      CurrentURIMetaData: buildMetadata(metadata)
    };

    self.callAction('AVTransport', 'SetAVTransportURI', params, function(err) {
      if(err) return callback(err);
      if(options.autoplay) {
        self.play(callback);
        return;
      }
      callback();
    });
  });
};

function buildMetadata(metadata) {
  var didl = et.Element('DIDL-Lite');
  didl.set('xmlns', 'urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/');
  didl.set('xmlns:dc', 'http://purl.org/dc/elements/1.1/');
  didl.set('xmlns:upnp', 'urn:schemas-upnp-org:metadata-1-0/upnp/');
  didl.set('xmlns:sec', 'http://www.sec.co.kr/');

  var item = et.SubElement(didl, 'item');
  item.set('id', 0);
  item.set('parentID', -1);
  item.set('restricted', false);

  var OBJECT_CLASSES = {
    'audio': 'object.item.audioItem.musicTrack',
    'video': 'object.item.videoItem.movie',
    'image': 'object.item.imageItem.photo'
  }

  if(metadata.type) {
    var klass = et.SubElement(item, 'upnp:class');
    klass.text = OBJECT_CLASSES[metadata.type];
  }

  if(metadata.title) {
    var title = et.SubElement(item, 'dc:title');
    title.text = metadata.title;
  }

  if(metadata.creator) {
    var creator = et.SubElement(item, 'dc:creator');
    creator.text = metadata.creator;
  }

  if(metadata.url && metadata.protocolInfo) {
    var res = et.SubElement(item, 'res');
    res.set('protocolInfo', metadata.protocolInfo);
    res.text = metadata.url;
  }

  if(metadata.subtitlesUrl) {
    var captionInfo = et.SubElement(item, 'sec:CaptionInfo');
    captionInfo.set('sec:type', 'srt');
    captionInfo.text = metadata.subtitlesUrl;

    var captionInfoEx = et.SubElement(item, 'sec:CaptionInfoEx');
    captionInfoEx.set('sec:type', 'srt');
    captionInfoEx.text = metadata.subtitlesUrl;

    // Create a second `res` for the subtitles
    var res = et.SubElement(item, 'res');
    res.set('protocolInfo', 'http-get:*:text/srt:*');
    res.text = metadata.subtitlesUrl;
  }

  var doc = new et.ElementTree(didl);
  var xml = doc.write({ xml_declaration: false });

  return xml;
}
// end monkey patching


var SSDP
try {
  SSDP = require('node-ssdp').Client
} catch (err) {
  SSDP = null
}

var thunky = require('thunky')

var noop = function () {}

module.exports = function () {
  var that = new events.EventEmitter()
  var casts = {}
  var ssdp = SSDP ? new SSDP() : null

  that.players = []

  var emit = function (cst) {
    if (!cst || !cst.host || cst.emitted) return
    cst.emitted = true

    var player = new events.EventEmitter()

    var connect = thunky(function reconnect (cb) {
      var client = new MediaRenderer(player.xml)

      client.on('error', function (err) {
        player.emit('error', err)
      })

      client.on('status', function (status) {
        if (status.TransportState === 'PLAYING') player._status.playerState = 'PLAYING'
        if (status.TransportState === 'PAUSED_PLAYBACK') player._status.playerState = 'PAUSED'
        player.emit('status', player._status)
      })

      client.on('loading', function (err) {
        player.emit('loading', err)
      })

      client.on('close', function () {
        connect = thunky(reconnect)
      })

      player.client = client
      cb(null, player.client)
    })

    var parseTime = function (time) {
      if (!time || time.indexOf(':') === -1) return 0
      var parts = time.split(':').map(Number)
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    player.name = cst.name
    player.host = cst.host
    player.xml = cst.xml
    player._status = {}
    player.MAX_VOLUME = 100

    player.play = function (url, opts, cb) {
      if (typeof opts === 'function') return player.play(url, null, opts)
      if (!opts) opts = {}
      if (!url) return player.resume(cb)
      if (!cb) cb = noop
      player.subtitles = opts.subtitles
      connect(function (err, p) {
        if (err) return cb(err)

        var media = {
          autoplay: opts.autoPlay !== false,
          contentType: opts.type || mime.lookup(url, 'video/mp4'),
          metadata: opts.metadata || {
            title: opts.title || '',
            dlnaFeatures: "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01100000000000000000000000000000",
            type: 'video', // can be 'video', 'audio' or 'image'
            subtitlesUrl: player.subtitles && player.subtitles.length ? player.subtitles[0] : null
          }
        }

        var callback = cb
        if (opts.seek) {
          callback = function () {
            player.seek(opts.seek, cb)
          }
        }

        p.load(url, media, callback)
      })
    }

    player.resume = function (cb) {
      if (!cb) cb = noop
      player.client.play(cb)
    }

    player.pause = function (cb) {
      if (!cb) cb = noop
      player.client.pause(cb)
    }

    player.stop = function (cb) {
      if (!cb) cb = noop
      player.client.stop(cb)
    }

    player.status = function (cb) {
      if (!cb) cb = noop
      parallel({
        currentTime: function (acb) {
          var params = {
            InstanceID: player.client.instanceId
          }
          player.client.callAction('AVTransport', 'GetPositionInfo', params, function (err, res) {
            if (err) return
            var position = parseTime(res.AbsTime) | parseTime(res.RelTime)
            acb(null, position)
          })
        },
        volume: function (acb) {
          player._volume(acb)
        }
      },
      function (err, results) {
        debug('%o', results)
        player._status.currentTime = results.currentTime
        player._status.volume = {level: results.volume / (player.MAX_VOLUME)}
        return cb(err, player._status)
      })
    }

    player._volume = function (cb) {
      var params = {
        InstanceID: player.client.instanceId,
        Channel: 'Master'
      }
      player.client.callAction('RenderingControl', 'GetVolume', params, function (err, res) {
        if (err) return
        var volume = res.CurrentVolume ? parseInt(res.CurrentVolume) : 0
        cb(null, volume)
      })
    }

    player.volume = function (vol, cb) {
      if (!cb) cb = noop
      var params = {
        InstanceID: player.client.instanceId,
        Channel: 'Master',
        DesiredVolume: (player.MAX_VOLUME * vol) | 0
      }
      player.client.callAction('RenderingControl', 'SetVolume', params, cb)
    }

    player.request = function (target, action, data, cb) {
      if (!cb) cb = noop
      player.client.callAction(target, action, data, cb)
    }

    player.seek = function (time, cb) {
      if (!cb) cb = noop
      player.client.seek(time, cb)
    }

    player._detectVolume = function (cb) {
      if (!cb) cb = noop
      player._volume(function (err, currentVolume) {
        if (err) cb(err)
        player.volume(player.MAX_VOLUME, function (err) {
          if (err) cb(err)
          player._volume(function (err, maxVolume) {
            if (err) cb(err)
            player.MAX_VOLUME = maxVolume
            player.volume(currentVolume, function (err) {
              cb(err, maxVolume)
            })
          })
        })
      })
    }

    that.players.push(player)
    that.emit('update', player)
  }

  if (ssdp) {
    ssdp.on('response', function (headers, statusCode, info) {
      if (!headers.LOCATION) return

      get.concat(headers.LOCATION, function (err, res, body) {
        if (err) return
        parseString(body.toString(), {explicitArray: false, explicitRoot: false},
          function (err, service) {
            if (err) return
            if (!service.device) return

            debug('device %j', service.device)

            var name = service.device.friendlyName

            if (!name) return

            var host = info.address
            var xml = headers.LOCATION

            if (!casts[name]) {
              casts[name] = {name: name, host: host, xml: xml}
              return emit(casts[name])
            }

            if (casts[name] && !casts[name].host) {
              casts[name].host = host
              casts[name].xml = xml
              emit(casts[name])
            }
          })
      })
    })
  }

  that.update = function () {
    debug('querying ssdp')
    if (ssdp) {
		ssdp.search('urn:schemas-upnp-org:device:MediaRenderer:1');
		setTimeout(function() {},5000);
	}
  }

  that.destroy = function () {
  }

  that.update()

  return that
}
