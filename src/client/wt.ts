import * as debugLib from "debug";
import { EventEmitter } from "events";
import * as WebTorrent from "webtorrent";
import { formatBytes } from "./util";

const debug = debugLib("FileSend-WebTorrent");

/*
* A client for sending and receiving files, which internally
* uses a WebTorrent client.
*
* Events emitted:
*   - **error**
*		- err: string | Error
*	- **upload** (Emitted whenever new packets are uploaded, for showing upload stats)
*		- uploaded: string (formatted as '20 MB' for example)
*		- uploadSpeed: string (formatted as '4 MB/s' for example)
*	- **download** (Emitted whenever new packets are downloaded, for showing
        download stats) (Note: these have same format as above)
*		- downloaded: string
*		- downloadSpeed: string
*		- progress: number (between 0 and 1)
*       - progressFiles: number[]
*       - timeRemaining: number (time remaining in ms)
*   - **progressUpdate** (Info got from the client downloading)
*       - progress: number (between 0 and 1)
*       - progressFiles: number[]
*       - timeRemaining: number (time remaining in milliseconds)
*   - **fileDownloadComplete** (Download of a file now complete)
*       - index: number (index of file whose download is complete)
*       - url: string (blobURL of the file downloaded)
*   - **seeding** (Begun seeding the file(s))
*   - **downloading** (Begun downloading the file(s))
*	- **downloadComplete**
*   - **torrentDestroyed** (the torrent that was downloading/seeding was destroyed)
*   - **clientDestroyed** (WebTorrent client was destroyed, possibly due to some error)
*/
export default class Client extends EventEmitter {
    public fileNames: string[] | undefined;
    private readonly socket: SocketIOClient.Socket;
    private readonly TRACKER_URLS: string[];
    private readonly client: WebTorrent.Instance;
    private readonly TIME_INTERVAL = 500; // Interval to report progress (ms)

    /*
    * Assuming use of SocketIO for comm. to server.
    * socket is the socket object of client connected.
    *
    * Uses STUN_URL and TRACKER_URL environment variables
    * for setting. If not set, falls back to third party
    * defaults.
    */
    constructor(socket: SocketIOClient.Socket) {
        super();
        let STUN_URL: string;
        let TRACKER_URL: string;

        if (process.env.STUN_URL) {
            STUN_URL = `stun:${process.env.STUN_URL}:3478`;
        } else {
            STUN_URL = "stun:stun.l.google.com:19302";
            debug(`STUN_URL env variable not set`);
        }
        debug(`Using ${STUN_URL} as STUN server address`);

        if (process.env.TRACKER_URL) {
            TRACKER_URL = `ws://${process.env.TRACKER_URL}:8000`;
        } else {
            TRACKER_URL = `wss://tracker.btorrent.xyz`;
            debug("TRACKER_URL env variable not set");
        }
        debug(`Using ${TRACKER_URL} as TRACKER address`);

        this.client = new WebTorrent({
            tracker: {
                iceServers: [{ urls: STUN_URL }],
            },
        });

        this.TRACKER_URLS = [ TRACKER_URL ];

        this.socket = socket;
        this.socket.on("addTorrent", (magnetUri: string) => {
            this.addTorrent(magnetUri);
        });

        // Fatal errors, client is destroyed after encounter
        this.client.on("error", (err) => {
            debug(`WebTorrent client encountered an error: ${err}`);
            this.emit("error", err);
            this.emit("clientDestroyed");
        });
    }

    public sendFiles = (files: File | File[] | FileList ) => {
        this.client.seed(files, { announce: this.TRACKER_URLS } , (torrent) => {
            this.setTorrentErrorHandlers(torrent);
            this.setFileNames(torrent);
            this.emit("seeding");
            this.socket.emit("fileReady", torrent.magnetURI);

            this.socket.on("progressUpdate", (info: any) => {
                this.emit("progressUpdate", info);
            });

            torrent.on("upload", (bytes) => {
                this.emit("upload", {
                    uploadSpeed: formatBytes(torrent.uploadSpeed) + "/s",
                    uploaded: formatBytes(torrent.uploaded),
                });
            });

            this.socket.on("torrentDone", (magnetUri: string) => {
                torrent.destroy(() => {
                    debug("Torrent destroyed, as server sent torrentDone");
                    this.emit("torrentDestroyed");
                });
            });
        });
    }

    /*
    * Expects an array of booleans to select and deselect files to download
    * E.g. Considering a torrent with 3 files, passing [true, false, true]
    * would result in first and third being selected, and second deselected
    */
    public selectFiles = (fileSelections: boolean[]) => {
        const torrent = this.client.torrents[0]; // Only one torrent is being used.
        if (fileSelections.length !== torrent.files.length) {
            debug(`Got ${fileSelections.length} length of choices, expected ${torrent.files.length}`);
            debug("Ignored file selection choices");
        } else {
            torrent.deselect(0, torrent.pieces.length - 1, 0);
            for (let i = 0; i < torrent.files.length; i++) {
                const file = torrent.files[i];
                if (fileSelections[i]) {
                    file.select();
                } else {
                    file.deselect();
                }
            }
            debug("Implemented file selection choices");
        }
    }

    /*
    * Assumes all files of the torrent are to be downloaded as of now
    * Use selectFiles method to deselect files.
    */
    public addTorrent = (magnetURI: string) => {
        const torrent = this.client.add(magnetURI, { announce: this.TRACKER_URLS }, () => {
            this.emit("downloading");
        });

        let downloadInfoInterval: number; // Unique ID of progress reporting interval
        let progressFiles: number[];

        const onDownload = () => {
            if (progressFiles === undefined) {
                progressFiles = new Array(torrent.files.length);
                for (let i = 0; i < progressFiles.length; i++) {
                    progressFiles[i] = 0;
                }
            }

            torrent.files.forEach( (file, i) => {
                progressFiles[i] = file.progress;
            });

            this.emit("download", {
                downloadSpeed: formatBytes(torrent.downloadSpeed) + "/s",
                downloaded: formatBytes(torrent.downloaded),
                progress: torrent.progress,
                progressFiles,
                timeRemaining: torrent.timeRemaining,
            });
        };

        torrent.on("metadata", () => {
            progressFiles = new Array(torrent.files.length);
            for (let i = 0; i < progressFiles.length; i++) {
                progressFiles[i] = 0;
            }
            this.setFileNames(torrent);
        });

        torrent.on("ready", () => {
            debug("Torrent beginning to download");

            torrent.files.forEach( (file, i) => {
                file.getBlobURL( (err, url) => {
                    if (err) {
                        debug(`Obtaining file ${file.name}: ${err}`);
                    } else if (url === undefined) {
                        debug(`Got undefined url for file ${file.name}`);
                    } else {
                        this.emit("fileDownloadComplete", {
                            index: i,
                            url,
                        });
                    }
                });
            });

            const socket = this.socket;
            const sendProgress = () => {
                socket.emit("progressUpdate", {
                    progress: torrent.progress,
                    progressFiles,
                    timeRemaining: torrent.timeRemaining,
                });
            };

            downloadInfoInterval = window.setInterval(() => {
                sendProgress();
                onDownload();
            }, this.TIME_INTERVAL);

            torrent.on("done", () => {
                debug("Torrent download complete");
                this.socket.emit("downloadComplete");
                this.emit("downloadComplete");
                clearInterval(downloadInfoInterval);
                onDownload(); // To completely update download info
                sendProgress();
            });
        });
    }

    // Should be used as client = client.destroy();
    public destroy = () => {
        this.client.destroy();
        return null;
    }

    private setFileNames = (torrent: WebTorrent.Torrent) => {
        this.fileNames = new Array(torrent.files.length);
        for (let i = 0; i < torrent.files.length; i++) {
            this.fileNames[i] = torrent.files[i].name;
        }
    }

    private setTorrentErrorHandlers = (torrent: WebTorrent.Torrent) => {
        // NOTE: torrents are destroyed when they encounter an error
        torrent.on("error", (err) => {
            debug(`Torrent encountered an error: ${err}`);
            this.emit("error", err);
            this.emit("torrentDestroyed");
        });

        // Warnings are not fatal, but useful for debugging
        torrent.on("warning", (err) => {
            debug(`Torrent warning: ${err}`);
        });
    }
}
