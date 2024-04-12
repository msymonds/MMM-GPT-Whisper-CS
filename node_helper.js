const NodeHelper = require('node_helper');
const Log = require("logger");
const PlayerMP3 = require('play-sound')(opts = { player: "mpg123" });
const PlayerWav = require('play-sound')(opts = { player: "aplay" });
const path = require('path');
const fs = require('fs');
const url = require('url');
const Lame = require("node-lame").Lame;
const { Buffer } = require('buffer');
const axios = require('axios');
const FormData = require('form-data');
const wave = require('wavefile');
const querystring = require('querystring');
const { DOMParser, XMLSerializer } = require('xmldom');

// ChainLang.
const { ConversationChain } = require("langchain/chains");
const { ChatOpenAI } = require("langchain/chat_models/openai");
const { BufferMemory } = require("langchain/memory");
const {  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  SystemMessagePromptTemplate,
  MessagesPlaceholder } = require("langchain/prompts");
const {
  Porcupine,
  BuiltinKeyword,
} = require("@picovoice/porcupine-node");
const { PvRecorder } = require("@picovoice/pvrecorder-node");

module.exports = NodeHelper.create({
  start: function() {
    console.log("Starting node_helper for: " + this.name);
  },

  socketNotificationReceived: function(notification, payload) {
    if (notification === 'CONFIG') {
      this.config = payload;

      // We're always listening o_0 (unless we're processing)
      this.state = 'listening';
      this.player = false;

      // Audio recorder.
      this.setupAudioRecorder();

      // Set up some paths.
      const modulePath = path.resolve(__dirname);
      this.soundFolder = path.join(modulePath, 'sounds');
      this.chain = this.initGPT();
    }
  },

  setupAudioRecorder: async function() {
    // const porcupine = new Porcupine(
    //   this.config.picovoiceKey,
    //   [BuiltinKeyword[this.config.picovoiceWord]],
    //   [0.65]
    // );
    if (this.config.debug) {
      console.log(PvRecorder.getAudioDevices());
    }
    this.audio = [];

    const frameLength = 512;
    const silenceDuration = this.config.picovoiceSilenceTime * 16000 / frameLength;
    let silenceFrames = 0;
    let isSilenceDetected = false;

    // Experimental values for PvRecorder constructor
    const audioDeviceIndex = this.config.audioDeviceIndex;
    const bufferSizeMSec = 500; // Experiment with different buffer sizes in milliseconds
    const logOverflow = false;
    const logSilence = false;

    const recorder = new PvRecorder(
      audioDeviceIndex,
      frameLength,
      bufferSizeMSec,
      logOverflow,
      logSilence
    );


    recorder.start();

    if (this.config.debug) {
      console.log(`Using device: ${recorder.getSelectedDevice()}...`);
      // console.log(`Listening for wake word: ${this.config.picovoiceWord}`);
    }


    let isInterrupted = false;
    this.backgroundNoiseLevel = 0;
    this.backgroundNoiseSamples = 0;

    while (!isInterrupted) {
      const pcm = await recorder.read();

      if (this.state === 'listening') {
        this.audio.push(...pcm);
      }

      // Let's try and detect X seconds of silence.
      this.updateBackgroundNoiseLevel(pcm);
      this.detectSilence(pcm);

      if (this.silenceFrames >= silenceDuration) {
        if (!isSilenceDetected) {
          console.log("Silence detected...");
          this.stopRecording();
          isSilenceDetected = true;
        }
        // Perform any action when silence is detected for the specified duration
        // For example, stop recording, trigger an event, etc.
      } else {
        isSilenceDetected = false;
      }
    }

    // Stop the recorder when the process is interrupted
    process.on("SIGINT", function () {
      isInterrupted = true;
      recorder.release();
      process.exit();
    });
  },

  updateBackgroundNoiseLevel: function(pcm) {
    // Calculate the RMS of the current PCM data
    const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + sample ** 2, 0) / pcm.length);

    // Update the background noise level
    this.backgroundNoiseLevel = ((this.backgroundNoiseLevel * this.backgroundNoiseSamples) + rms) / (this.backgroundNoiseSamples + 1);
    this.backgroundNoiseSamples++;
  },

  detectSilence: function(pcm) {
    // Calculate the RMS of the current PCM data
    const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + sample ** 2, 0) / pcm.length);

    // Calculate the silence threshold based on the background noise level
    const silenceThreshold = this.backgroundNoiseLevel * this.config.picovoiceSilenceThreshold;

    // Detect silence
    if (rms < silenceThreshold) {
      this.silenceFrames++;
    } else {
      this.silenceFrames = 0;
    }
  },


  startRecording: function() {
    if (this.player !== false) {
      this.player.kill('SIGINT');
      this.player = false;
    }

    this.playSound(this.soundFolder + '/notification_start.mp3');
    this.sendSocketNotification('START_RECORDING');

    // If we're recording, let's stop and clean-up and restart.
    if (this.state === 'recording') {
      this.audio = [];
      this.cleanupFiles();
    }

    // Set the flag.
    this.state = 'recording';
    this.sendSocketNotification('HIDE_ALERT');
  },

  stopRecording: async function() {
    // Record and convert.
    if (this.state === 'listening') {
      this.sendSocketNotification('STOP_RECORDING');

      const wav = new wave.WaveFile();
      wav.fromScratch(1, 16000, '16', this.audio);

      // Close the output stream
      console.log('Recording complete!');

      // Reset the flag.
      this.state = 'processing';
    }
    // Process to text.
    let requestText = '';
    if (this.state === 'processing') {
      // Upload directly.
      requestText = await this.uploadToWhisper(wav.toBuffer());
    }

    // Get a reply.
    let replyText = '';
    if (this.state === 'processing') {
      if (requestText.toLowerCase().includes('command')) {
        this.processCommand(requestText);
      }
      else {
        try {
          if (requestText && requestText.length > 0) {
            replyText = await this.getGPTReply(requestText);
          }
        }
        catch (e) {
          console.log(e);
        }
      }
    }

    // Text-to-speech.
    // if (this.state === 'processing' && requestText && replyText.length > 0) {
    //   this.ttsPlay(replyText);
    // }
  },

  ttsPlay: function(text) {
    text = this.fixMalformedXML(text);
    let params = {
      voice: this.config.mimic3Voice,
      noiseScale: 0.2,
      noiseW: 0.2,
      lengthScale: 1.0,
      ssml: true
    };

    let parsedUrl = url.parse(this.config.mimic3Url, true);
    parsedUrl.pathname = '/api/tts';
    parsedUrl.query = params;
    const apiUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}:${parsedUrl.port}/api/tts?${querystring.stringify(params)}`;

    const self = this;

    axios({
      method: 'post',
      url: apiUrl,
      headers: {'Content-Type': 'text/plain'},
      data: text,
      responseType: 'stream'
    })
      .then(function (response) {
        // Save the response to a temporary file
        const tempFilePath = '/tmp/gpt-reply.wav';
        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);
        writer.on('error', (error) => {
          console.error('Error occurred:', error);
        });

        writer.on('finish', () => {
          // Play the saved audio file
          console.log('Playing audio reply...');
          self.player = PlayerWav.play(tempFilePath, function(err){
            console.log(err);
          });
        });
      })
      .catch(function (error) {
        console.log(error);
        this.sendSocketNotification('ERROR', 'Error from Mimic3.');
      });
  },

  convertWavToMp3: function() {
    return new Promise((resolve, reject) => {
      const encoder = new Lame({
        output: "/tmp/request.mp3",
        bitrate: 192,
      }).setFile("/tmp/request.wav");

      encoder
        .encode()
        .then(() => {
          console.log('MP3 conversion complete!');
          resolve(); // Resolve the promise when encoding is finished
        })
        .catch((error) => {
          console.log('Something went wrong with MP3 encoding: ' + error);
          reject(error); // Reject the promise if encoding fails
          this.sendSocketNotification('ERROR', 'Error converting WAV to MP3.');
        });
    });
  },

  uploadToWhisper: async function(wavData) {
    try {
      const formData = new FormData();
      formData.append('audio_file', wavData, {
        filename: 'request.wav',
        contentType: 'audio/wav',
      });

      const response = await axios.post(
        'http://192.168.1.223:5000/transcribe',
        formData,
        {
          headers: formData.getHeaders(),        
        }
      );

      // Log the entire response to the console for now
      console.log(response);

      this.sendSocketNotification('REQUEST_PROCESSED', response.data.text);

      // Clean-up
      this.cleanupFiles();
      this.requestText = response.data.text;
      return response.data.text;

    } catch (error) {
      console.error('Error uploading file:', error);
      this.sendSocketNotification('ERROR', 'server not reachable.');
    }
  },

  initGPT: function () {
    const chat = new ChatOpenAI({
      openAIApiKey: this.config.openAiKey,
      temperature: 0.9,
      modelName: "gpt-3.5-turbo",
      streaming: false
    });

    const chatPrompt = ChatPromptTemplate.fromPromptMessages([
      SystemMessagePromptTemplate.fromTemplate(
        this.config.openAiSystemMsg
      ),
      new MessagesPlaceholder("history"),
      HumanMessagePromptTemplate.fromTemplate("{input}"),
    ]);

    return new ConversationChain({
      memory: new BufferMemory({ returnMessages: true, memoryKey: "history", aiPrefix: this.config.picovoiceWord }),
      prompt: chatPrompt,
      llm: chat,
    });
  },

  getGPTReply: async function(requestText) {
    console.log('Sending request to OpenAPI: ' + requestText);
    try {
      const response = await this.chain.call({
        input: requestText,
      });
      console.log('OpenAI Response:');
      console.log(response);
      this.sendSocketNotification('REPLY_RECEIVED', response.response);

      return response.response;
    }
    catch (e) {
      this.sendSocketNotification('ERROR', 'Error from ChatGPT API.');
    }
  },

  processCommand: function(text) {
    this.sendSocketNotification('CUSTOM_COMMAND', text);
  },

  cleanupFiles: function() {
    this.audio = [];
    fs.unlink('/tmp/request.wav', (err) => {
      if (err) {
        console.error('Error deleting file (/tmp/request.wav):', err);
      } else {
        console.log('File deleted successfully: /tmp/request.wav');
      }
    });
    fs.unlink('/tmp/request.mp3', (err) => {
      if (err) {
        console.error('Error deleting file (/tmp/request.mp3):', err);
      } else {
        console.log('File deleted successfully: /tmp/request.mp3');
      }
    });
  },

  playSound: function playSound(soundFilePath) {
    if (this.player !== false) {
      this.player.kill('SIGINT');
      this.player = false;
    }
    this.player = PlayerMP3.play(soundFilePath, (err) => {
      if (err) {
        console.error(`Failed to play sound ${soundFilePath}: ${err}`);
      }
    });
  },


  fixMalformedXML: function (xmlString) {
    const parser = new DOMParser();
    const dom = parser.parseFromString(xmlString, "text/xml");
    const serializer = new XMLSerializer();
    const fixedXMLString = serializer.serializeToString(dom);
    return fixedXMLString;
  }
});