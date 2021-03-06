
import * as vscode from 'vscode';
import * as pb from './protobuf/innpv_pb';
import * as path from 'path';
import * as cp from 'child_process';

import {Socket} from 'net';
import { simpleDecoration } from './decorations';

const crypto = require('crypto');
const resolve = require('path').resolve

export interface SkylineSessionOptions {
    context: vscode.ExtensionContext;
    projectRoot: string;
    addr: string;
    port: number;
    webviewPanel: vscode.WebviewPanel
}

export interface SkylineEnvironment {
    binaryPath: string;
    reactProjectRoot: string;
}

export class SkylineSession {
    // Backend socket connection
    skylineProcess?: cp.ChildProcess;
    connection: Socket;
    seq_num: number;
    last_length: number;
    message_buffer: Uint8Array;
    startSkyline?: () => void | undefined;

    // Set to true if the backend should be restarted
    backendShouldRestart: boolean;

    // VSCode extension and views
    context: vscode.ExtensionContext;
    webviewPanel: vscode.WebviewPanel;
    openedEditors: Map<string, vscode.TextEditor>

    // Received messages
    msg_initialize?: pb.InitializeResponse;
    msg_throughput?: pb.ThroughputResponse;
    msg_breakdown?: pb.BreakdownResponse;
    msg_habitat?: pb.HabitatResponse;

    // Project information
    root_dir: string;

    // Environment
    reactProjectRoot: string;

    constructor(options: SkylineSessionOptions, environ: SkylineEnvironment) {
        console.log("SkylineSession instantiated");

        this.backendShouldRestart = false;
        this.connection = new Socket();
        this.connection.on('data', this.on_data.bind(this));
        this.connection.on('close', this.on_close.bind(this));
        this.connection.connect(options.port, options.addr, this.on_open.bind(this));

        this.seq_num = 0;
        this.last_length = -1;
        this.message_buffer = new Uint8Array();

        this.context = options.context;
        this.webviewPanel = options.webviewPanel;
        this.openedEditors = new Map<string, vscode.TextEditor>();

        this.root_dir = options.projectRoot;
        this.reactProjectRoot = environ.reactProjectRoot;

        this.webviewPanel.webview.onDidReceiveMessage(this.webview_handle_message.bind(this));
        this.webviewPanel.onDidDispose(this.kill_backend.bind(this));

        vscode.workspace.onDidChangeTextDocument(this.on_text_change.bind(this));
	this.restart_profiling = this.restart_profiling.bind(this);
    }

    send_message(message: any, payloadName: string) {
        let msg = new pb.FromClient();
        msg.setSequenceNumber(this.seq_num ++);
        if (payloadName == "Initialize") {
            msg.setInitialize(message);
        } else if (payloadName == "Analysis") {
            msg.setAnalysis(message);
        } else {
            msg.setGeneric(message);
        }

        let buf = msg.serializeBinary();
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32BE(buf.length, 0);
        this.connection.write(lengthBuffer);
        this.connection.write(buf);
    }

    on_open() {
        // Send skyline initialization request
        console.log("Sending initialization request");
        const message = new pb.InitializeRequest();
        message.setProtocolVersion(5);
        this.send_message(message, "Initialize");
    }

    send_analysis_request() {
        // Send skyline analysis request
        console.log("Sending analysis request");
        const message = new pb.AnalysisRequest();
        message.setMockResponse(false);
        this.send_message(message, "Analysis");
    }

    kill_backend() {
        this.skylineProcess?.kill('SIGKILL');
    }

    restart_profiling() {
	console.log("restart_profiling", this.startSkyline, this.skylineProcess);
        this.backendShouldRestart = true;
        this.skylineProcess?.kill('SIGKILL');
	// this.startSkyline && this.startSkyline();
    }

    on_text_change() {
        console.log("Text change");
        let changeEvent = {
            "message_type": "text_change"
        };
        this.webviewPanel.webview.postMessage(changeEvent);
    }

    report_error(err_text: String) {
        console.log("Reporting Error");
        let errorEvent = {
            "message_type": "error",
            "error_text": err_text
        };
        this.webviewPanel.webview.postMessage(errorEvent);
    }

    webview_handle_message(msg: any) {
        console.log("webview_handle_message");
        console.log(msg);

        if (msg['command'] == 'begin_analysis_clicked') {
			vscode.window.showInformationMessage("Sending analysis request.");
			this.send_analysis_request();
        } else if (msg['command'] == 'restart_profiling_clicked') {
			vscode.window.showInformationMessage("Restarting profiling.");
            this.restart_profiling();
        }
    }

    async on_data(message: Uint8Array) {
        console.log("received data. length ", message.byteLength);

        // Append new message
        // TODO: Make this less inefficient
        let newBuffer = new Uint8Array(this.message_buffer.byteLength + message.byteLength);
        newBuffer.set(this.message_buffer);
        newBuffer.set(message, this.message_buffer.byteLength);
        this.message_buffer = newBuffer;

        while (this.message_buffer.byteLength >= 4) {
            // Read new message length
            if (this.last_length == -1) {
                this.last_length = (this.message_buffer[0] << 24) | 
                                   (this.message_buffer[1] << 16) |
                                   (this.message_buffer[2] << 8) | 
                                   this.message_buffer[3];
                this.message_buffer = this.message_buffer.slice(4);
            }

            // Digest message or quit if buffer not large enough
            if (this.message_buffer.byteLength >= this.last_length) {
                console.log("Handling message of length", this.last_length);
                let body = this.message_buffer.slice(0, this.last_length);
                this.handle_message(body);

                this.message_buffer = this.message_buffer.slice(this.last_length);
                this.last_length = -1;
            }
        }
    }

    async handle_message(message: Uint8Array) {
        try {
            let msg = pb.FromServer.deserializeBinary(message);
            console.log(msg.getPayloadCase());
            switch(msg.getPayloadCase()) {
                case pb.FromServer.PayloadCase.ERROR:
                    break;
                case pb.FromServer.PayloadCase.INITIALIZE:
                    this.msg_initialize = msg.getInitialize();
                    // TODO: Move this to other file.
                    this.webviewPanel.webview.html = await this._getHtmlForWebview();
                    break;
                case pb.FromServer.PayloadCase.ANALYSIS_ERROR:
                    break;
                case pb.FromServer.PayloadCase.THROUGHPUT:
                    this.msg_throughput = msg.getThroughput();
                    break;
                case pb.FromServer.PayloadCase.BREAKDOWN:
                    this.msg_breakdown = msg.getBreakdown();
                    // this.highlight_breakdown();
                    break;
                case pb.FromServer.PayloadCase.HABITAT:
                    this.msg_habitat = msg.getHabitat();
                    break;
            };

            // this.webviewPanel.webview.html = await this.rEaCt();
            let json_msg = await this.generateStateJson();
            json_msg['message_type'] = 'analysis';
            this.webviewPanel.webview.postMessage(json_msg);
        } catch (e) {
            console.log("exception!");
            console.log(message);
            console.log(e);
        }
    }

    highlight_breakdown() {
        if (this.msg_breakdown) {
            let highlights = new Map<string, Array<[number, vscode.MarkdownString]>>();
            for (let node of this.msg_breakdown.getOperationTreeList()) {
                for (let ctx of node.getContextsList()) {
                    let path = ctx.getFilePath()?.getComponentsList().join("/");
                    let lineno = ctx.getLineNumber();
                    let opdata = node.getOperation();

                    if (path) {
                        let lst = highlights.get(path);
                        if (!lst) {
                            lst = new Array<[number, vscode.MarkdownString]>();
                            highlights.set(path, lst);
                        }

                        let label = new vscode.MarkdownString();
                        label.appendMarkdown(`**Forward**: ${opdata!.getForwardMs().toFixed(3)} ms\n\n`);
                        label.appendMarkdown(`**Backward**: ${opdata!.getBackwardMs().toFixed(3)} ms\n\n`);
                        label.appendMarkdown(`**Size**: ${opdata!.getSizeBytes()} bytes\n\n`);
                        lst.push([lineno, label]);
                    }
                }
            }

            for (let path of highlights.keys()) {
                let uri = vscode.Uri.parse(this.root_dir + "/" + path);
                console.log("opening file", uri.toString());
                vscode.workspace.openTextDocument(uri).then(document => {
                    vscode.window.showTextDocument(document, vscode.ViewColumn.Beside).then(editor => {
                    // vscode.window.showTextDocument(document, vscode.ViewColumn.One).then(editor => {
                        let decorations = [];
                        for (let marker of highlights.get(path)!) {
                            let range = new vscode.Range(
                                new vscode.Position(marker[0]-1, 0),
                                new vscode.Position(marker[0]-1, 
                                    document.lineAt(marker[0]-1).text.length)
                            );
                            decorations.push({
                                range: range,
                                hoverMessage: marker[1]
                            });
                        }
                        editor.setDecorations(simpleDecoration, decorations);
                    });
                });
            }
        }
    }

    on_close() {
        console.log("Socket Closed!");
    }

    private _getHtmlForWebview() {
        const buildPath = resolve(this.reactProjectRoot);
        console.log("resolved buildPath", buildPath);

		const manifest = require(path.join(buildPath, 'build', 'asset-manifest.json'));
		const mainScript = manifest['files']['main.js'];
		const mainStyle = manifest['files']['main.css'];

		const scriptPathOnDisk = vscode.Uri.file(path.join(buildPath, 'build', mainScript));
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
		const stylePathOnDisk = vscode.Uri.file(path.join(buildPath, 'build', mainStyle));
		const styleUri = stylePathOnDisk.with({ scheme: 'vscode-resource' });

		// Use a nonce to whitelist which scripts can be run
		const nonce = crypto.randomBytes(16).toString('base64');

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
				<meta name="theme-color" content="#000000">
				<title>Skyline</title>
				<link rel="stylesheet" type="text/css" href="${styleUri}">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;">
				<base href="${vscode.Uri.file(path.join(buildPath, 'build')).with({ scheme: 'vscode-resource' })}/">
			</head>
			<body>
				<noscript>You need to enable JavaScript to run this app.</noscript>
				<div id="root"></div>
				
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}

    async generateStateJson() {
        let fields = {
            "message_type": "analysis",

            "project_root": this.msg_initialize?.getServerProjectRoot()?.toString(),
            "project_entry_point": this.msg_initialize?.getEntryPoint()?.toString(),

            "throughput": {},
            "breakdown": {},

            "habitat": [] as Array<[string, number]>
        };

        if (this.msg_throughput) {
            fields['throughput'] = {
                "samples_per_second": this.msg_throughput?.getSamplesPerSecond(),
                "predicted_max_samples_per_second": this.msg_throughput?.getPredictedMaxSamplesPerSecond(),
                "run_time_ms": [ 
                    this.msg_throughput?.getRunTimeMs()?.getSlope(),
                    this.msg_throughput?.getRunTimeMs()?.getBias()
                ],
                "peak_usage_bytes": [ 
                    this.msg_throughput?.getPeakUsageBytes()?.getSlope(),
                    this.msg_throughput?.getPeakUsageBytes()?.getBias()
                ],
                "batch_size_context": this.msg_throughput?.getBatchSizeContext()?.toString(),
                "can_manipulate_batch_size": this.msg_throughput?.getCanManipulateBatchSize()
            };
        }

        if (this.msg_breakdown) {
            fields['breakdown'] = {
                "peak_usage_bytes": this.msg_breakdown.getPeakUsageBytes(),
                "memory_capacity_bytes": this.msg_breakdown.getMemoryCapacityBytes(),
                "iteration_run_time_ms": this.msg_breakdown.getIterationRunTimeMs(),
                "batch_size": this.msg_breakdown.getBatchSize(),
                "num_nodes_operation_tree": this.msg_breakdown.getOperationTreeList().length,
                "num_nodes_weight_tree": this.msg_breakdown.getWeightTreeList().length
            };
        }

        if (this.msg_habitat) {
            for (let prediction of this.msg_habitat.getPredictionsList()) {
                fields['habitat'].push([ prediction.getDeviceName(), prediction.getRuntimeMs() ]);
            }
        }

        return fields;
    }
}
