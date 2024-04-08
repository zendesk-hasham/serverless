const axios = require("axios");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

let response;

const zendeskDomain = "${ZENDESK-SUBDOMAIN}.zendesk.com";
const ticketId = 291;
const username = "${ZENDESKEMAIL}/token";
const password = "${ZENDESK-API-KEY}";
const smtpHost = "smtp.gmail.com";
const smtpPort = 587;
const smtpUser = "${SMTP-USERNAME}";
const smtpPassword = "${SMTP-PASSWORD}";
const forwardingEmailTo = "${FORWARDING-EAMIL-TO}";

var transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: false, // true for 465, false for other ports
  auth: {
    user: smtpUser,
    pass: smtpPassword,
  },
});

// Helper function to download a file to the /tmp directory
async function downloadAttachment(attachment) {
  const response = await axios({
    method: "GET",
    url: attachment.content_url,
    responseType: "stream",
  });

  const filePath = path.join("/tmp", attachment.file_name);

  // Return a new Promise that resolves with the file path or rejects with an error
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    writer.on("finish", () => resolve(filePath));
    writer.on("error", reject);
  });
}

exports.lambdaHandler = async (event, context) => {
  // Encode the credentials in base64 for the Authorization header
  const auth = Buffer.from(`${username}:${password}`).toString("base64");

  try {
    const response = await axios.get(
      `https://${zendeskDomain}/api/v2/tickets/${ticketId}?include=users`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    // Extract the subject, description, and requester_id from the ticket
    const { subject, description, requester_id } = response.data.ticket;

    // Find the user that matches the requester_id
    const requester = response.data.users.find(
      (user) => user.id === requester_id
    );

    // Check if the requester is an end-user and get their email
    const requesterEmail =
      requester && requester.role === "end-user" ? requester.email : null;

    const ticketComments = await axios.get(
      `https://${zendeskDomain}/api/v2/tickets/${ticketId}/comments`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    const attachmentDetails = ticketComments.data.comments
      //.filter((comment) => comment.author_id === requester_id) // Only comments from the specified author.
      .flatMap((comment) =>
        comment.attachments.map((attachment) => ({
          content_url: attachment.content_url,
          file_name: attachment.file_name,
          content_type: attachment.content_type,
          size: attachment.size,
        }))
      );
    console.log("Downloading attachment ....");
    const attachments = await Promise.all(
      attachmentDetails.map(downloadAttachment)
    );

    console.log("Sending email ....");

    let mailOptions = {
      from: requesterEmail,
      to: forwardingEmailTo,
      subject: subject,
      text: description,
      attachments: attachments.map((filePath) => ({
        filename: path.basename(filePath),
        path: filePath,
      })),
      //html: body_txt
    };

    const mailResponse = await transporter.sendMail(mailOptions);
    console.log(mailResponse);

    //TODO Update ticket to let ticket know that email forwarding was successful.

    const responsePayload = {
      statusCode: 200,
      body: JSON.stringify({
        subject: subject,
        description: description,
        requester_id: requester_id,
        requesterEmail: requesterEmail,
        attachments: attachmentDetails,
      }),
    };

    return responsePayload;
  } catch (error) {
    console.error("Error forwarding ticket:", error);

    return {
      statusCode: error.response ? error.response.status : 500,
      body: JSON.stringify({
        message: "Error forwarding ticket",
        details: error,
      }),
    };
  }
};
